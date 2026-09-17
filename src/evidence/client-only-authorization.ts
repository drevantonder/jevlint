import { parseSync, Visitor } from "oxc-parser";
import type { Expression, Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, RelatedProjectModule } from "./repository.js";

export type ClientGuardKind = "predicate" | "route-guard" | "disabled-prop";

export type ClientGuard = {
  source: string;
  line: number;
  kind: ClientGuardKind;
  signal: string;
};

export type ServerSignal = {
  location: "same-module" | "candidate";
  source: string;
  line: number;
};

export type ClientOnlyAuthorizationEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  clientGuards: ClientGuard[];
  serverSignals: ServerSignal[];
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

const AUTH_IDENTIFIER = /isAdmin|isOwner|isMember|hasRole|hasPermission|requireRole|canEdit|canView|canDelete|can[A-Z]\w*|userRole|user\.role|role|permission|admin|authorize/i;
const ROUTE_GUARD_CALL = /^(requireRole|requireAuth|requirePermission|withAuth|withRole|beforeEnter|canActivate|authorize|checkRole)$/;
const SERVER_READ = /getServerSession|getSession|verifySession|authenticate|requireAuth|session|claims|serverAuth/i;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function identifiersIn(test: Expression, source: string): string[] {
  const names = new Set<string>();
  const text = nodeSource(test, source);
  for (const match of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    if (AUTH_IDENTIFIER.test(match[0])) names.add(match[0]);
  }
  return [...names];
}

function finalCalleeName(callee: Expression): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression") {
    if (callee.property.type === "Identifier") return callee.property.name;
    if (callee.property.type === "Literal") return String(callee.property.value);
  }
  return null;
}

export function buildClientOnlyAuthorizationEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ClientOnlyAuthorizationEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseSync(ownerFile.filePath, ownerFile.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const guards: ClientGuard[] = [];
  const pushGuard = (node: Node, kind: ClientGuardKind, signal: string): void => {
    guards.push({
      source: nodeSource(node, ownerFile.source).slice(0, 300),
      line: lineAt(ownerFile.source, node.start),
      kind,
      signal,
    });
  };

  new Visitor({
    IfStatement(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const names = identifiersIn(node.test, ownerFile.source);
      if (names.length > 0) pushGuard(node.test, "predicate", names.join(","));
    },
    ConditionalExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const names = identifiersIn(node.test, ownerFile.source);
      if (names.length > 0) pushGuard(node.test, "predicate", names.join(","));
    },
    LogicalExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.operator !== "&&") return;
      const names = identifiersIn(node, ownerFile.source);
      if (names.length > 0 && nodeSource(node, ownerFile.source).includes("<")) {
        pushGuard(node, "predicate", names.join(","));
      }
    },
    CallExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const name = finalCalleeName(node.callee);
      if (name && ROUTE_GUARD_CALL.test(name)) pushGuard(node, "route-guard", name);
    },
    JSXElement(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      for (const attribute of node.openingElement.attributes) {
        if (attribute.type !== "JSXAttribute") continue;
        if (attribute.name.type !== "JSXIdentifier" || attribute.name.name !== "disabled") continue;
        const valueText = attribute.value ? nodeSource(attribute.value, ownerFile.source) : "";
        if (AUTH_IDENTIFIER.test(valueText)) {
          pushGuard(attribute, "disabled-prop", valueText.slice(0, 120));
        }
      }
    },
  }).visit(parsed.program);
  if (guards.length === 0) return undefined;

  const serverSignals: ServerSignal[] = [];
  new Visitor({
    Identifier(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (!SERVER_READ.test(node.name)) return;
      serverSignals.push({
        location: "candidate",
        source: node.name,
        line: lineAt(ownerFile.source, node.start),
      });
    },
  }).visit(parsed.program);
  new Visitor({
    Identifier(node) {
      if (containsNode(fn, node)) return;
      if (!SERVER_READ.test(node.name)) return;
      serverSignals.push({
        location: "same-module",
        source: ownerFile.source.slice(Math.max(0, node.start - 60), node.end + 40),
        line: lineAt(ownerFile.source, node.start),
      });
      if (serverSignals.length >= 10) return;
    },
  }).visit(parsed.program);

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    clientGuards: guards.slice(0, 10),
    serverSignals: serverSignals.slice(0, 10),
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(
        candidate.filePath,
        parsed.program,
        projectFiles,
      ),
    },
  };
}
