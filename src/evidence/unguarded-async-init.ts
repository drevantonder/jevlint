import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { AssignmentExpression, Expression, IfStatement, Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, containsNode, nestedFunctionRanges } from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, RelatedProjectModule } from "./repository.js";

export type AsyncInitGuardKind = "null-check" | "falsy-check" | "nullish-assign" | "or-assign";

export type AsyncInitGuard = {
  source: string;
  binding: string;
  bindingScope: "module" | "local" | "outer-or-import";
  guardKind: AsyncInitGuardKind;
  awaitedInit: string;
};

export type UnguardedAsyncInitEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  guards: AsyncInitGuard[];
  inFlightSharing: {
    present: boolean;
    slots: string[];
    awaited: string[];
  };
  repository: {
    callers: FunctionCaller[];
    concurrentEntryHints: string[];
    relatedModules: RelatedProjectModule[];
  };
};

const CONCURRENT_ENTRY_PATTERN = /handler|handle|route|controller|server|request|worker|parallel/i;

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function isNullishLiteral(node: { type: string; value?: unknown; name?: unknown }): boolean {
  if (node.type === "Literal") return node.value === null;
  if (node.type === "Identifier") return node.name === "undefined";
  return false;
}

function guardNameFromTest(test: Expression): { name: string; guardKind: "null-check" | "falsy-check" } | undefined {
  const direct = test.type === "ChainExpression" ? test.expression : test;
  if (direct.type === "UnaryExpression" && direct.operator === "!") {
    const operand = direct.argument.type === "ChainExpression" ? direct.argument.expression : direct.argument;
    if (operand.type === "Identifier") return { name: operand.name, guardKind: "falsy-check" };
    return undefined;
  }
  if (
    direct.type === "BinaryExpression"
    && ["==", "===", "!=", "!=="].includes(direct.operator)
    && (isNullishLiteral(direct.left) || isNullishLiteral(direct.right))
  ) {
    const other = isNullishLiteral(direct.left) ? direct.right : direct.left;
    const unwrapped = other.type === "ChainExpression" ? other.expression : other;
    if (unwrapped.type === "Identifier") return { name: unwrapped.name, guardKind: "null-check" };
  }
  return undefined;
}

export function buildUnguardedAsyncInitEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnguardedAsyncInitEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const nested = nestedFunctionRanges(parsed.program, fn);
  const source = ownerFile.source;

  const inScope = (node: Node): boolean =>
    containsNode(fn, node) && belongsDirectlyToFunction(node, nested);

  const awaitedRanges: NodeRange[] = [];
  new Visitor({
    AwaitExpression(node) {
      if (!inScope(node)) return;
      awaitedRanges.push({ start: node.start, end: node.end });
    },
  }).visit(parsed.program);
  const rhsIsAwaited = (right: Expression): boolean =>
    awaitedRanges.some((range) => right.start <= range.start && right.end >= range.end);

  type PendingWrite = { name: string; source: string; awaited: boolean; start: number; end: number };
  const pendingWrites: PendingWrite[] = [];
  const guardSites: { name: string; guardKind: AsyncInitGuardKind; site: IfStatement | AssignmentExpression }[] = [];

  new Visitor({
    IfStatement(node) {
      if (!inScope(node)) return;
      const guard = guardNameFromTest(node.test);
      if (!guard) return;
      guardSites.push({ name: guard.name, guardKind: guard.guardKind, site: node });
    },
    AssignmentExpression(node) {
      if (!inScope(node)) return;
      if (node.left.type !== "Identifier") return;
      if (node.operator === "??=" || node.operator === "||=") {
        guardSites.push({
          name: node.left.name,
          guardKind: node.operator === "??=" ? "nullish-assign" : "or-assign",
          site: node,
        });
      }
      pendingWrites.push({
        name: node.left.name,
        source: nodeSource(node, source),
        awaited: rhsIsAwaited(node.right),
        start: node.start,
        end: node.end,
      });
    },
  }).visit(parsed.program);

  const moduleBindings = new Set<string>();
  for (const statement of parsed.program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const item of declaration.declarations) {
      if (item.id.type === "Identifier") moduleBindings.add(item.id.name);
    }
  }
  const localBindings = new Set<string>();
  for (const parameter of fn.params) {
    const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(parameter.start, parameter.end));
    if (match?.[0]) localBindings.add(match[0]);
  }
  new Visitor({
    VariableDeclarator(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.id.type === "Identifier") localBindings.add(node.id.name);
    },
  }).visit(parsed.program);

  const scopeOf = (binding: string): AsyncInitGuard["bindingScope"] => {
    if (moduleBindings.has(binding)) return "module";
    if (localBindings.has(binding)) return "local";
    return "outer-or-import";
  };

  const guards: AsyncInitGuard[] = [];
  for (const site of guardSites) {
    const match = pendingWrites.find((write) =>
      write.name === site.name
      && write.awaited
      && site.site.start <= write.start
      && site.site.end >= write.end
    );
    if (!match) continue;
    if (guards.some(({ binding, awaitedInit }) => binding === site.name && awaitedInit === match.source)) {
      continue;
    }
    guards.push({
      source: nodeSource(site.site, source),
      binding: site.name,
      bindingScope: scopeOf(site.name),
      guardKind: site.guardKind,
      awaitedInit: match.source,
    });
  }
  if (guards.length === 0) return undefined;

  const awaitedNames = new Set<string>();
  new Visitor({
    AwaitExpression(node) {
      if (!inScope(node)) return;
      const target = node.argument.type === "ChainExpression" ? node.argument.expression : node.argument;
      if (target.type === "Identifier") awaitedNames.add(target.name);
      if (target.type === "MemberExpression" && target.object.type === "Identifier") {
        awaitedNames.add(target.object.name);
      }
    },
  }).visit(parsed.program);
  const sharedSlots = [...new Set(
    pendingWrites.filter(({ name, awaited }) => !awaited && awaitedNames.has(name)).map(({ name }) => name),
  )];

  const name = functionName(parsed.program, fn);
  const callers = name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [];
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: source.slice(0, 16_000),
    },
    guards,
    inFlightSharing: {
      present: sharedSlots.length > 0,
      slots: pendingWrites.filter(({ awaited }) => !awaited).map(({ source: text }) => text).slice(0, 10),
      awaited: [...awaitedNames].slice(0, 10),
    },
    repository: {
      callers,
      concurrentEntryHints: callers
        .filter(({ filePath }) => CONCURRENT_ENTRY_PATTERN.test(filePath))
        .map(({ filePath }) => filePath)
        .slice(0, 10),
      relatedModules: findRelatedProjectModules(candidate.filePath, parsed.program, projectFiles),
    },
  };
}
