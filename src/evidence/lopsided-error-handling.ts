import { Visitor } from "oxc-parser";
import type { CallExpression, NewExpression, Program } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";

export type GuardedOperation = {
  call: string;
  callee: string;
  awaited: boolean;
  guarded: boolean;
  /**
   * The call's value is returned through a `return fail(...)` / `return
   * err(...)` shape, so the return itself is the failure handling. The
   * operation sits on the handled side of its group without being wrapped.
   */
  handledByReturn: boolean;
  line: number;
};

export type OperationGroup = {
  kind: string;
  guarded: GuardedOperation[];
  unguarded: GuardedOperation[];
};

export type LowRiskOperation = {
  call: string;
  callee: string;
  line: number;
  /** Names the approximation that cleared this call; see NO_THROW_REACH. */
  reason: string;
};

export type LopsidedErrorHandlingEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  groups: OperationGroup[];
  lowRisk: LowRiskOperation[];
  outerHandlerCoversBody: boolean;
};

/**
 * Handling by return, enumerated exactly. A call counts as handled (not bare)
 * when BOTH hold:
 *
 * - position: the call span sits inside a `return <argument>` span. This
 *   covers `return fail(...)`, `return await fail(...)`, and nested shapes
 *   such as `return { outcome: fail(...) }` — in each, the failure value
 *   escapes through the return.
 * - callee: the call's terminal identifier is in RETURNED_FAILURE_CALLEES:
 *   `fail` (form-action / CLI style failure values that print and exit
 *   nonzero instead of throwing) or `err` (Result-style failure
 *   constructors). Bare and member shapes (`fail(...)`, `res.fail(...)`)
 *   match by terminal name.
 *
 * A try/catch net would catch nothing from these calls — nothing is thrown,
 * so the returned failure value IS the handling. A discarded `fail(...);`
 * statement is NOT handling: the value goes nowhere.
 */
const RETURNED_FAILURE_CALLEES: ReadonlySet<string> = new Set(["fail", "err"]);

/**
 * NO-THROW-REACH: a conservative static stand-in for effect analysis. A
 * bare-identifier callee is provably safe only when exactly one top-level
 * project-local function defines it AND that function span (body plus
 * parameter defaults) — plus every transitively reached bare-identifier
 * call — contains no `throw`, no
 * `await`, no `yield`, and no call or `new` except bare-identifier calls to
 * provably safe locals. Everything else (member calls such as `db.ship()` or
 * `items.map()`, unresolved names, zero or several competing definitions,
 * recursion cycles, nested-function indirection, unparseable files) means
 * "cannot tell", and the callee is treated as CAN-THROW — the previous
 * analysis. The approximation only ever removes certain-safe calls from
 * lopsidedness; it never adds any.
 */
const NO_THROW_REACH = "no-throw-reach" as const;

type LocalDefinition = {
  program: Program;
  /** Whole function node span, so parameter defaults are scanned too. */
  start: number;
  end: number;
};

function terminalCallee(node: CallExpression, source: string): string {
  if (node.callee.type === "Identifier") return node.callee.name;
  if (
    node.callee.type === "MemberExpression"
    && node.callee.property.type === "Identifier"
  ) return node.callee.property.name;
  return source.slice(node.callee.start, node.callee.end);
}

function collectLocalDefinitions(
  projectFiles: ProjectFile[],
): Map<string, LocalDefinition[]> | undefined {
  const definitions = new Map<string, LocalDefinition[]>();
  const add = (name: string, definition: LocalDefinition): void => {
    const existing = definitions.get(name) ?? [];
    existing.push(definition);
    definitions.set(name, existing);
  };
  for (const file of projectFiles) {
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
    for (const statement of parsed.program.body) {
      const declaration = statement.type === "ExportNamedDeclaration"
        || statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;
      if (
        declaration?.type === "FunctionDeclaration"
        && declaration.id?.name
        && declaration.body
      ) {
        add(declaration.id.name, {
          program: parsed.program,
          start: declaration.start,
          end: declaration.end,
        });
        continue;
      }
      if (declaration?.type !== "VariableDeclaration") continue;
      for (const item of declaration.declarations) {
        if (item.id.type !== "Identifier" || !item.init) continue;
        if (
          item.init.type !== "ArrowFunctionExpression"
          && item.init.type !== "FunctionExpression"
        ) continue;
        add(item.id.name, {
          program: parsed.program,
          start: item.init.start,
          end: item.init.end,
        });
      }
    }
  }
  return definitions;
}

function collectCallable(
  node: CallExpression | NewExpression,
  pending: string[],
  onUnknown: () => void,
): void {
  if (node.callee.type !== "Identifier") {
    onUnknown();
    return;
  }
  pending.push(node.callee.name);
}

function definitionLooksSafe(
  definition: LocalDefinition,
  definitions: Map<string, LocalDefinition[]>,
  seen: ReadonlySet<string>,
): boolean {
  const nested: Array<{ start: number; end: number }> = [];
  const collectNested = (node: { start: number; end: number }): void => {
    if (node.start === definition.start && node.end === definition.end) return;
    if (node.start >= definition.start && node.end <= definition.end) {
      nested.push({ start: node.start, end: node.end });
    }
  };
  new Visitor({
    ArrowFunctionExpression: collectNested,
    FunctionDeclaration: collectNested,
    FunctionExpression: collectNested,
  }).visit(definition.program);
  const inNested = (node: { start: number; end: number }): boolean =>
    nested.some((range) => range.start <= node.start && range.end >= node.end);

  let safe = true;
  const pending: string[] = [];
  const markUnknown = (): void => {
    safe = false;
  };
  new Visitor({
    ThrowStatement(node) {
      if (node.start >= definition.start && node.end <= definition.end && !inNested(node)) {
        safe = false;
      }
    },
    AwaitExpression(node) {
      if (node.start >= definition.start && node.end <= definition.end && !inNested(node)) {
        safe = false;
      }
    },
    YieldExpression(node) {
      if (node.start >= definition.start && node.end <= definition.end && !inNested(node)) {
        safe = false;
      }
    },
    CallExpression(node) {
      if (node.start < definition.start || node.end > definition.end || inNested(node)) return;
      collectCallable(node, pending, markUnknown);
    },
    NewExpression(node) {
      if (node.start < definition.start || node.end > definition.end || inNested(node)) return;
      collectCallable(node, pending, markUnknown);
    },
  }).visit(definition.program);
  if (!safe) return false;
  return pending.every((name) => isProvablySafe(name, definitions, seen));
}

function isProvablySafe(
  name: string,
  definitions: Map<string, LocalDefinition[]>,
  seen: ReadonlySet<string>,
): boolean {
  if (seen.has(name)) return false;
  const matches = definitions.get(name) ?? [];
  if (matches.length !== 1) return false;
  const definition = matches[0];
  if (!definition) return false;
  const next = new Set(seen);
  next.add(name);
  return definitionLooksSafe(definition, definitions, next);
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

export function buildLopsidedErrorHandlingEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): LopsidedErrorHandlingEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn || !fn.body) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  const nested = nestedFunctionRanges(parsed.program, candidate);

  const direct = (start: number, end: number): boolean =>
    start >= candidate.start
    && end <= candidate.end
    && !nested.some((range) => range.start <= start && range.end >= end);

  const tryRanges: Array<{ start: number; end: number; statementCount: number }> = [];
  const awaitRanges: Array<{ start: number; end: number }> = [];
  const returnArgRanges: Array<{ start: number; end: number }> = [];
  const catchChained = new Set<string>();
  new Visitor({
    TryStatement(node) {
      if (!direct(node.start, node.end)) return;
      tryRanges.push({ start: node.start, end: node.end, statementCount: node.block.body.length });
    },
    AwaitExpression(node) {
      if (direct(node.start, node.end)) awaitRanges.push({ start: node.start, end: node.end });
    },
    ReturnStatement(node) {
      if (!direct(node.start, node.end)) return;
      if (node.argument) returnArgRanges.push({ start: node.argument.start, end: node.argument.end });
    },
    CallExpression(node) {
      if (!direct(node.start, node.end)) return;
      if (node.callee.type !== "MemberExpression") return;
      if (node.callee.property.type !== "Identifier" || node.callee.property.name !== "catch") return;
      catchChained.add(owner.source.slice(node.callee.object.start, node.callee.object.end));
    },
  }).visit(parsed.program);

  const bodySpan = Math.max(1, fn.body.end - fn.body.start);
  const outerHandlerCoversBody = tryRanges.some(
    (range) => (range.end - range.start) / bodySpan >= 0.8,
  );
  if (outerHandlerCoversBody) return undefined;

  const definitions = collectLocalDefinitions(projectFiles);
  const safeCache = new Map<string, boolean>();
  const isSafeCallee = (calleeName: string): boolean => {
    const cached = safeCache.get(calleeName);
    if (cached !== undefined) return cached;
    const result = definitions !== undefined
      && isProvablySafe(calleeName, definitions, new Set());
    safeCache.set(calleeName, result);
    return result;
  };

  const operations: GuardedOperation[] = [];
  const lowRisk: LowRiskOperation[] = [];
  new Visitor({
    CallExpression(node) {
      if (!direct(node.start, node.end)) return;
      if (node.callee.type === "MemberExpression"
        && node.callee.property.type === "Identifier"
        && node.callee.property.name === "catch") return;
      const text = owner.source.slice(node.start, node.end);
      const callee = owner.source.slice(node.callee.start, node.callee.end);
      const awaited = awaitRanges.some((range) => range.start <= node.start && range.end >= node.end);
      const inTry = tryRanges.some((range) => range.start <= node.start && range.end >= node.end);
      const handledByReturn = RETURNED_FAILURE_CALLEES.has(terminalCallee(node, owner.source))
        && returnArgRanges.some((range) => range.start <= node.start && range.end >= node.end);
      if (!inTry && !handledByReturn && node.callee.type === "Identifier" && isSafeCallee(node.callee.name)) {
        // Only the unhandled safe calls are listed: guarded ones are already
        // handling evidence, so Jev needs no extra fact about them.
        lowRisk.push({
          call: text,
          callee,
          line: lineAt(owner.source, node.start),
          reason: `${NO_THROW_REACH}: '${node.callee.name}' resolves to a single project-local body with no throw, await, yield, or unresolved call in reach`,
        });
        return;
      }
      operations.push({
        call: text,
        callee,
        awaited,
        guarded: inTry || catchChained.has(text),
        handledByReturn,
        line: lineAt(owner.source, node.start),
      });
    },
  }).visit(parsed.program);

  if (operations.length === 0) return undefined;

  const byKind = new Map<string, GuardedOperation[]>();
  for (const operation of operations) {
    const root = operation.callee.includes(".")
      ? (operation.callee.split(".")[0] ?? operation.callee)
      : operation.callee;
    const key = `${operation.awaited ? "await:" : "call:"}${root}`;
    const existing = byKind.get(key) ?? [];
    existing.push(operation);
    byKind.set(key, existing);
  }

  const groups: OperationGroup[] = [];
  for (const [kind, items] of byKind) {
    const guarded = items.filter((item) => item.guarded || item.handledByReturn);
    const unguarded = items.filter((item) => !item.guarded && !item.handledByReturn);
    if (items.length >= 2 && guarded.length > 0 && unguarded.length > 0) {
      groups.push({ kind, guarded, unguarded });
    }
  }
  if (groups.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    groups,
    lowRisk,
    outerHandlerCoversBody,
  };
}
