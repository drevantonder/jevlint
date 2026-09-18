import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type {
  Argument,
  CallExpression,
  Expression,
  NewExpression,
  ObjectExpression,
  Program,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  calleeRootName,
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type {
  FunctionCaller,
  FunctionNode,
  RelatedProjectModule,
} from "./repository.js";

type WaitCallEvidence = {
  expression: string;
  client: string;
  kind: "fetch" | "client" | "websocket" | "project-wrapper";
  hasTimeoutOption: boolean;
  hasSignal: boolean;
  closeHandling: boolean | null;
  importedFrom: string | null;
  wrapperPolicy: string | null;
  targetModule: { filePath: string; source: string } | null;
};

export type UnboundedWaitEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  waitCalls: WaitCallEvidence[];
  abortControlInScope: boolean;
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

const NETWORK_CLIENT_SOURCES = new Set(["axios", "got", "undici", "node:http", "node:https"]);

function objectOptionNames(object: ObjectExpression): string[] {
  const names: string[] = [];
  for (const property of object.properties) {
    if (property.type !== "Property" || property.computed) continue;
    const key = property.key;
    if (key.type === "Identifier") names.push(key.name);
  }
  return names;
}

function objectArgument(argument: Argument | undefined): ObjectExpression | undefined {
  if (!argument) return undefined;
  const value = argument.type === "ChainExpression" ? argument.expression : argument;
  return value.type === "ObjectExpression" ? value : undefined;
}

function hasOption(call: CallExpression, pattern: RegExp): boolean {
  return call.arguments.some((argument) => {
    const object = objectArgument(argument);
    return object !== undefined && objectOptionNames(object).some((name) => pattern.test(name));
  });
}

function newTargetName(node: NewExpression): string | null {
  const callee = node.callee;
  if (callee.type === "Identifier") return callee.name;
  return null;
}

function websocketCloseHandling(
  variable: string | undefined,
  fn: FunctionNode,
  program: Program,
  nested: NodeRange[],
): boolean {
  let handled = false;
  new Visitor({
    CallExpression(call) {
      if (handled || !containsNode(fn, call) || !belongsDirectlyToFunction(call, nested)) return;
      const callee = call.callee;
      if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier") return;
      if (callee.property.name !== "close") return;
      if (variable === undefined) {
        handled = true;
        return;
      }
      const target = callee.object;
      if (target.type === "Identifier" && target.name === variable) handled = true;
    },
    MemberExpression(node) {
      if (handled || !containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.property.type !== "Identifier" || node.property.name !== "onclose") return;
      handled = true;
    },
  }).visit(program);
  return handled;
}

function abortControlPresent(program: Program): boolean {
  let present = false;
  new Visitor({
    NewExpression(node) {
      if (present) return;
      if (newTargetName(node) === "AbortController") present = true;
    },
    CallExpression(call) {
      if (present) return;
      const callee = call.callee;
      if (
        callee.type === "MemberExpression"
        && callee.object.type === "Identifier"
        && callee.object.name === "AbortSignal"
        && callee.property.type === "Identifier"
        && callee.property.name === "timeout"
      ) present = true;
    },
  }).visit(program);
  return present;
}

function wrapperNetworkPolicy(
  target: ProjectFile,
  importedName: string,
): string | undefined {
  const parsed = parseCached(target.filePath, target.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  let range: NodeRange | undefined;
  new Visitor({
    FunctionDeclaration(node) {
      if (!range && node.id?.name === importedName) range = node;
    },
    VariableDeclarator(node) {
      if (
        !range
        && node.id.type === "Identifier"
        && node.id.name === importedName
        && node.init
        && (node.init.type === "ArrowFunctionExpression" || node.init.type === "FunctionExpression")
      ) range = node.init;
    },
  }).visit(parsed.program);
  if (!range) return undefined;
  const bounds: string[] = [];
  const unbounded: string[] = [];
  const local = range;
  new Visitor({
    CallExpression(call) {
      if (call.start < local.start || call.end > local.end) return;
      const root = calleeRootName(call.callee);
      const imports = moduleImports(parsed.program);
      const imported = root ? imports.find(({ local: name }) => name === root) : undefined;
      if (root === "fetch" && !imported) {
        (hasOption(call, /^signal$/i)
          ? bounds
          : unbounded).push(target.source.slice(call.start, call.end));
      } else if (imported && NETWORK_CLIENT_SOURCES.has(imported.source)) {
        (hasOption(call, /timeout|deadline/i)
          ? bounds
          : unbounded).push(target.source.slice(call.start, call.end));
      }
    },
  }).visit(parsed.program);
  if (bounds.length > 0) return `wrapper sets a default bound: ${bounds[0]}`;
  if (unbounded.length > 0) return `wrapper leaves the wait unbounded: ${unbounded[0]}`;
  return undefined;
}

function assignedName(node: NewExpression, program: Program): string | undefined {
  let name: string | undefined;
  new Visitor({
    VariableDeclarator(declaration) {
      if (declaration.init === node && declaration.id.type === "Identifier") {
        name = declaration.id.name;
      }
    },
  }).visit(program);
  return name;
}

function expressionText(expression: Expression, source: string): string {
  return source.slice(expression.start, expression.end);
}

export function buildUnboundedWaitEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnboundedWaitEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const imports = moduleImports(parsed.program);
  const waitCalls: WaitCallEvidence[] = [];
  const seen = new Set<number>();

  const push = (evidence: WaitCallEvidence & NodeRange): void => {
    if (seen.has(evidence.start)) return;
    seen.add(evidence.start);
    waitCalls.push({
      expression: evidence.expression,
      client: evidence.client,
      kind: evidence.kind,
      hasTimeoutOption: evidence.hasTimeoutOption,
      hasSignal: evidence.hasSignal,
      closeHandling: evidence.closeHandling,
      importedFrom: evidence.importedFrom,
      wrapperPolicy: evidence.wrapperPolicy,
      targetModule: evidence.targetModule,
    });
  };

  new Visitor({
    CallExpression(call) {
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested)) return;
      const source = ownerFile.source;
      const root = calleeRootName(call.callee);
      const imported = root ? imports.find(({ local }) => local === root) : undefined;
      if (root === "fetch" && !imported) {
        if (hasOption(call, /^signal$/i)) return;
        push({
          expression: expressionText(call, source),
          client: "fetch",
          kind: "fetch",
          hasTimeoutOption: false,
          hasSignal: false,
          closeHandling: null,
          importedFrom: null,
          wrapperPolicy: null,
          targetModule: null,
          start: call.start,
          end: call.end,
        });
        return;
      }
      if (imported && NETWORK_CLIENT_SOURCES.has(imported.source)) {
        if (hasOption(call, /timeout|deadline/i)) return;
        push({
          expression: expressionText(call, source),
          client: `${imported.source}#${imported.imported}`,
          kind: "client",
          hasTimeoutOption: false,
          hasSignal: hasOption(call, /^signal$/i),
          closeHandling: null,
          importedFrom: imported.source,
          wrapperPolicy: null,
          targetModule: null,
          start: call.start,
          end: call.end,
        });
        return;
      }
      if (imported && imported.source.startsWith(".")) {
        const target = resolveModule(ownerFile.filePath, imported.source, projectFiles);
        if (!target) return;
        const policy = wrapperNetworkPolicy(target, imported.imported);
        if (policy === undefined) return;
        push({
          expression: expressionText(call, source),
          client: `${imported.source}#${imported.imported}`,
          kind: "project-wrapper",
          hasTimeoutOption: policy.startsWith("wrapper sets"),
          hasSignal: false,
          closeHandling: null,
          importedFrom: imported.source,
          wrapperPolicy: policy,
          targetModule: { filePath: target.filePath, source: target.source.slice(0, 12_000) },
          start: call.start,
          end: call.end,
        });
      }
    },
    NewExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (newTargetName(node) !== "WebSocket") return;
      const source = ownerFile.source;
      const variable = assignedName(node, parsed.program);
      if (websocketCloseHandling(variable, fn, parsed.program, nested)) return;
      push({
        expression: expressionText(node, source),
        client: "WebSocket",
        kind: "websocket",
        hasTimeoutOption: false,
        hasSignal: false,
        closeHandling: false,
        importedFrom: null,
        wrapperPolicy: null,
        targetModule: null,
        start: node.start,
        end: node.end,
      });
    },
  }).visit(parsed.program);

  if (waitCalls.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    waitCalls,
    abortControlInScope: abortControlPresent(parsed.program),
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
