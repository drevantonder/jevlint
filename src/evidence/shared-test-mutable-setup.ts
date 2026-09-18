import { Visitor } from "oxc-parser";
import type { CallExpression, Expression, MemberExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { calleeRootName } from "./repository.js";
import { isTestFilePath, parseTestFunction } from "./test-scope.js";

export type SharedSetupWriteKind = "assign" | "update" | "mutate";

export type SharedSetupFlow = {
  variable: string;
  writtenIn: string;
  readIn: string;
  writeKind: SharedSetupWriteKind;
  writeSnippet: string;
  readSnippet: string;
};

export type SharedTestMutableSetupEvidence = {
  function: {
    title: string | null;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  sharedVariables: Array<{
    name: string;
    declaredIn: string;
    declaration: string;
  }>;
  flows: SharedSetupFlow[];
  tests: number;
  isolation: string[];
};

const TEST_ROOTS = new Set(["it", "test"]);
const HOOK_ROOTS = new Set(["beforeAll", "beforeEach", "afterAll", "afterEach"]);
const DESCRIBE_ROOTS = new Set(["describe"]);

const MUTATING_METHODS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
  "set",
  "delete",
  "add",
  "clear",
]);

const FRESH_INIT_TYPES = new Set([
  "ArrayExpression",
  "ObjectExpression",
  "NewExpression",
  "CallExpression",
  "Literal",
  "TemplateLiteral",
  "ArrowFunctionExpression",
  "FunctionExpression",
]);

const SNIPPET_CHARS = 160;

type RunnerCallback = {
  kind: "test" | "hook" | "describe";
  label: string;
  start: number;
  end: number;
};

type PendingWrite = {
  variable: string;
  context: string;
  kind: SharedSetupWriteKind;
  snippet: string;
  freshReset: boolean;
  start: number;
};

type PendingRead = {
  variable: string;
  context: string;
  snippet: string;
};

function truncate(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > SNIPPET_CHARS
    ? `${singleLine.slice(0, SNIPPET_CHARS - 1)}…`
    : singleLine;
}

function lineAt(source: string, offset: number): string {
  const lineStart = source.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = source.indexOf("\n", offset);
  return source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd);
}

function titleOf(call: CallExpression, source: string): string | null {
  const first = call.arguments[0];
  if (!first || first.type === "SpreadElement") return null;
  if (first.type === "TemplateLiteral" && first.expressions.length === 0) {
    return source.slice(first.start + 1, first.end - 1);
  }
  if (first.type !== "Literal") return null;
  const raw = source.slice(first.start, first.end);
  const quote = raw[0];
  if (quote !== "\"" && quote !== "'" && quote !== "`") return null;
  if (raw.length < 2 || raw[raw.length - 1] !== quote) return null;
  if (quote === "`" && raw.includes("${")) return null;
  return raw.slice(1, -1);
}

/** Root identifier behind an assignment target or member chain. */
function targetRootName(node: Expression | MemberExpression["object"]): string | null {
  let current: Expression | MemberExpression["object"] = node;
  while (current.type === "MemberExpression") current = current.object;
  if (current.type === "CallExpression") return calleeRootName(current.callee);
  if (current.type === "ChainExpression") {
    const chained = current.expression;
    if (chained.type === "CallExpression") return calleeRootName(chained.callee);
    if (chained.type === "MemberExpression") return targetRootName(chained.object);
    return null;
  }
  if (current.type === "Identifier") return current.name;
  if (
    current.type === "TSAsExpression"
    || current.type === "TSSatisfiesExpression"
    || current.type === "TSNonNullExpression"
    || current.type === "TSTypeAssertion"
  ) return targetRootName(current.expression);
  return null;
}

function callbackLabel(kind: RunnerCallback["kind"], root: string, title: string | null): string {
  if (kind === "test") return `test "${title ?? "(anonymous)"}"`;
  if (kind === "hook") return root;
  return `describe "${title ?? "(anonymous)"}"`;
}

export function buildSharedTestMutableSetupEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): SharedTestMutableSetupEvidence | undefined {
  if (!isTestFilePath(candidate.filePath)) return undefined;
  const scope = parseTestFunction(candidate, projectFiles);
  if (!scope) return undefined;
  if (scope.runner !== "it" && scope.runner !== "test") return undefined;
  const { owner, program } = scope;
  const source = owner.source;

  const callbacks: RunnerCallback[] = [];
  new Visitor({
    CallExpression(call) {
      if (call.callee.type === "CallExpression") return;
      const root = calleeRootName(call.callee);
      if (!root) return;
      const kind = TEST_ROOTS.has(root)
        ? "test"
        : HOOK_ROOTS.has(root)
          ? "hook"
          : DESCRIBE_ROOTS.has(root)
            ? "describe"
            : null;
      if (!kind) return;
      for (const argument of call.arguments) {
        if (argument.type === "SpreadElement") continue;
        const value = argument.type === "ChainExpression" ? argument.expression : argument;
        if (value.type !== "ArrowFunctionExpression" && value.type !== "FunctionExpression") {
          continue;
        }
        callbacks.push({
          kind,
          label: callbackLabel(kind, root, titleOf(call, source)),
          start: value.start,
          end: value.end,
        });
        break;
      }
    },
  }).visit(program);

  const tests = callbacks.filter((callback) => callback.kind === "test");
  if (tests.length < 2) return undefined;

  const candidateCallback = tests.find(
    (callback) => callback.start === scope.fn.start && callback.end === scope.fn.end,
  );
  if (!candidateCallback) return undefined;

  const testOrHook = callbacks.filter((callback) => callback.kind !== "describe");

  const innermostContext = (offset: number): RunnerCallback | undefined => {
    let best: RunnerCallback | undefined;
    for (const callback of callbacks) {
      if (offset < callback.start || offset > callback.end) continue;
      if (!best || (callback.start >= best.start && callback.end <= best.end)) best = callback;
    }
    return best;
  };

  const sharedNames = new Set<string>();
  const sharedVariables: SharedTestMutableSetupEvidence["sharedVariables"] = [];
  const exclusionRanges: Array<{ start: number; end: number }> = [];
  const namedBindings: Array<{ name: string; start: number; end: number }> = [];

  const recordParams = (params: Array<{ type: string; start: number; end: number; name?: string }>): void => {
    for (const param of params) {
      if (param.type === "Identifier" && param.name !== undefined) {
        namedBindings.push({ name: param.name, start: param.start, end: param.end });
      } else {
        exclusionRanges.push({ start: param.start, end: param.end });
      }
    }
  };

  new Visitor({
    VariableDeclaration(node) {
      if (node.kind !== "let" && node.kind !== "var") return;
      for (const declarator of node.declarations) {
        const id = declarator.id;
        if (id.type === "Identifier") {
          namedBindings.push({ name: id.name, start: id.start, end: id.end });
        } else {
          exclusionRanges.push({ start: id.start, end: id.end });
        }
      }
      const insideTestOrHook = testOrHook.some(
        (callback) => node.start >= callback.start && node.end <= callback.end,
      );
      if (insideTestOrHook) return;
      for (const declarator of node.declarations) {
        if (declarator.id.type !== "Identifier") continue;
        const name = declarator.id.name;
        if (sharedNames.has(name)) continue;
        sharedNames.add(name);
        const holder = innermostContext(node.start);
        sharedVariables.push({
          name,
          declaredIn: holder?.kind === "describe" ? holder.label : "module scope",
          declaration: truncate(source.slice(node.start, node.end)),
        });
      }
    },
    FunctionDeclaration(node) {
      if (node.id) exclusionRanges.push({ start: node.id.start, end: node.id.end });
      recordParams(node.params);
    },
    FunctionExpression(node) {
      if (node.id) exclusionRanges.push({ start: node.id.start, end: node.id.end });
      recordParams(node.params);
    },
    ArrowFunctionExpression(node) {
      recordParams(node.params);
    },
    VariableDeclarator(node) {
      if (node.id.type === "Identifier") return;
      exclusionRanges.push({ start: node.id.start, end: node.id.end });
    },
    ImportDeclaration(node) {
      exclusionRanges.push({ start: node.start, end: node.end });
    },
    MemberExpression(node) {
      if (!node.computed) exclusionRanges.push({ start: node.property.start, end: node.property.end });
    },
    Property(node) {
      if (!node.computed && !node.shorthand) {
        exclusionRanges.push({ start: node.key.start, end: node.key.end });
      }
    },
  }).visit(program);

  if (sharedNames.size === 0) return undefined;

  const writes: PendingWrite[] = [];
  const writeTargetRanges: Array<{ start: number; end: number }> = [];
  const reads: PendingRead[] = [];

  const isExcluded = (start: number, end: number): boolean =>
    exclusionRanges.some((range) => start >= range.start && end <= range.end)
    || writeTargetRanges.some((range) => start >= range.start && end <= range.end);

  const isShadowed = (name: string, context: RunnerCallback): boolean =>
    namedBindings.some(
      (binding) =>
        binding.name === name
        && binding.start > context.start
        && binding.end < context.end,
    );

  new Visitor({
    AssignmentExpression(node) {
      const name = node.left.type === "Identifier" || node.left.type === "MemberExpression"
        ? targetRootName(node.left)
        : null;
      if (!name || !sharedNames.has(name)) return;
      const context = innermostContext(node.start);
      if (!context) return;
      writeTargetRanges.push({ start: node.left.start, end: node.left.end });
      const freshReset = context.kind === "hook"
        && context.label === "beforeEach"
        && node.operator === "="
        && FRESH_INIT_TYPES.has(node.right.type);
      writes.push({
        variable: name,
        context: context.label,
        kind: "assign",
        snippet: truncate(source.slice(node.start, node.end)),
        freshReset,
        start: node.start,
      });
    },
    UpdateExpression(node) {
      const name = node.argument.type === "Identifier" || node.argument.type === "MemberExpression"
        ? targetRootName(node.argument)
        : null;
      if (!name || !sharedNames.has(name)) return;
      const context = innermostContext(node.start);
      if (!context) return;
      writeTargetRanges.push({ start: node.argument.start, end: node.argument.end });
      writes.push({
        variable: name,
        context: context.label,
        kind: "update",
        snippet: truncate(source.slice(node.start, node.end)),
        freshReset: false,
        start: node.start,
      });
    },
    CallExpression(call) {
      if (call.callee.type !== "MemberExpression" || call.callee.computed) return;
      if (call.callee.property.type !== "Identifier") return;
      if (!MUTATING_METHODS.has(call.callee.property.name)) return;
      const name = targetRootName(call.callee.object);
      if (!name || !sharedNames.has(name)) return;
      const context = innermostContext(call.start);
      if (!context) return;
      writeTargetRanges.push({
        start: call.callee.object.start,
        end: call.callee.object.end,
      });
      writes.push({
        variable: name,
        context: context.label,
        kind: "mutate",
        snippet: truncate(source.slice(call.start, call.end)),
        freshReset: false,
        start: call.start,
      });
    },
  }).visit(program);

  new Visitor({
    Identifier(node) {
      const name = node.name;
      if (!sharedNames.has(name)) return;
      if (isExcluded(node.start, node.end)) return;
      const context = innermostContext(node.start);
      if (!context) return;
      if (isShadowed(name, context)) return;
      reads.push({
        variable: name,
        context: context.label,
        snippet: truncate(lineAt(source, node.start)),
      });
    },
  }).visit(program);

  const isolation: string[] = [];
  for (const write of writes) {
    if (write.freshReset) {
      isolation.push(`beforeEach resets "${write.variable}" with a fresh value`);
    }
  }
  for (const name of sharedNames) {
    const arrangedLocally = namedBindings.some(
      (binding) =>
        binding.name === name
        && binding.start > candidateCallback.start
        && binding.end < candidateCallback.end,
    );
    if (arrangedLocally) isolation.push(`test arranges its own "${name}"`);
  }

  const flows: SharedSetupFlow[] = [];
  const seenFlows = new Set<string>();
  for (const read of reads) {
    for (const write of writes) {
      if (write.variable !== read.variable) continue;
      if (write.freshReset) continue;
      if (write.context === read.context) continue;
      const involvesCandidate = read.context === candidateCallback.label
        || write.context === candidateCallback.label;
      if (!involvesCandidate) continue;
      const key = `${write.variable}\u0000${write.context}\u0000${read.context}\u0000${write.start}`;
      if (seenFlows.has(key)) continue;
      seenFlows.add(key);
      flows.push({
        variable: read.variable,
        writtenIn: write.context,
        readIn: read.context,
        writeKind: write.kind,
        writeSnippet: write.snippet,
        readSnippet: read.snippet,
      });
    }
  }

  if (flows.length === 0) return undefined;

  flows.sort((left, right) =>
    left.variable.localeCompare(right.variable)
    || left.writtenIn.localeCompare(right.writtenIn)
    || left.readIn.localeCompare(right.readIn)
  );

  return {
    function: {
      title: scope.title,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    sharedVariables,
    flows,
    tests: tests.length,
    isolation,
  };
}
