import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression, Node } from "oxc-parser";
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

export type SharedMutation = {
  leg: string;
  source: string;
  checkThenAct: boolean;
};

export type MutatedBinding = {
  name: string;
  kind: "let" | "array" | "map" | "set" | "object";
  declaredIn: "module" | "closure";
  mutations: SharedMutation[];
};

export type ConcurrentSharedMutationEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  scheduling: {
    mechanisms: string[];
    legCount: number;
  };
  bindings: MutatedBinding[];
  coordination: {
    hasAggregation: boolean;
    signals: string[];
  };
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    return expression.object.type === "Super" ? undefined : rootIdentifier(expression.object);
  }
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  return undefined;
}

function isConcurrentScheduler(
  node: { callee: import("oxc-parser").CallExpression["callee"] },
): string | undefined {
  const callee = node.callee;
  if (callee.type === "MemberExpression") {
    const object = callee.object.type === "Identifier" ? callee.object.name : undefined;
    const property = callee.property.type === "Identifier" ? callee.property.name : undefined;
    if (object === "Promise" && (property === "all" || property === "allSettled" || property === "race" || property === "any")) {
      return `Promise.${property}`;
    }
    if ((property === "map" || property === "forEach" || property === "flatMap") && object !== undefined) {
      return `${property}-callback`;
    }
    if (property === "on" || property === "addEventListener" || property === "subscribe" || property === "postMessage") {
      return `${property}-handler`;
    }
  }
  if (callee.type === "Identifier" && (callee.name === "setTimeout" || callee.name === "setImmediate" || callee.name === "queueMicrotask")) {
    return `${callee.name}-callback`;
  }
  return undefined;
}

type CallbackLeg = {
  range: NodeRange;
  mechanism: string;
  source: string;
};

function collectLegs(
  fn: NodeRange,
  program: import("oxc-parser").Program,
  source: string,
  nested: NodeRange[],
): CallbackLeg[] {
  const legs: CallbackLeg[] = [];
  new Visitor({
    CallExpression(call) {
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested)) return;
      const mechanism = isConcurrentScheduler(call);
      if (!mechanism) return;
      for (const argument of call.arguments) {
        if (argument.type === "SpreadElement" || argument.type === "ArrayExpression") {
          const items = argument.type === "ArrayExpression" ? argument.elements : [argument.argument];
          for (const item of items) {
            if (!item || item.type === "SpreadElement") continue;
            const target = item.type === "ArrowFunctionExpression" || item.type === "FunctionExpression"
              ? item
              : undefined;
            if (target) {
              legs.push({ range: target, mechanism, source: nodeSource(target, source) });
            } else if (mechanism.startsWith("Promise.")) {
              legs.push({ range: item, mechanism, source: nodeSource(item, source) });
            }
          }
          continue;
        }
        if (
          argument.type === "ArrowFunctionExpression" || argument.type === "FunctionExpression"
        ) {
          legs.push({ range: argument, mechanism, source: nodeSource(argument, source) });
        }
      }
    },
  }).visit(program);
  return legs;
}

export function buildConcurrentSharedMutationEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ConcurrentSharedMutationEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const nested = nestedFunctionRanges(parsed.program, fn);

  const legs = collectLegs(fn, parsed.program, ownerFile.source, nested);
  if (legs.length === 0) return undefined;

  const bindings = new Map<string, { kind: MutatedBinding["kind"]; declaredIn: "module" | "closure" }>();
  const moduleBindings = new Set<string>();
  for (const statement of parsed.program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const item of declaration.declarations) {
      if (item.id.type === "Identifier") moduleBindings.add(item.id.name);
    }
  }
  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || !node.init) return;
      if (containsNode(fn, node)) return;
      const kind = node.init.type === "ArrayExpression"
        ? ("array" as const)
        : node.init.type === "ObjectExpression"
          ? ("object" as const)
          : node.init.type === "NewExpression" && node.init.callee.type === "Identifier" && node.init.callee.name === "Map"
            ? ("map" as const)
            : node.init.type === "NewExpression" && node.init.callee.type === "Identifier" && node.init.callee.name === "Set"
              ? ("set" as const)
              : node.init.type !== "ArrowFunctionExpression" && node.init.type !== "FunctionExpression"
                ? ("let" as const)
                : undefined;
      if (!kind) return;
      bindings.set(node.id.name, {
        kind,
        declaredIn: moduleBindings.has(node.id.name) ? "module" : "closure",
      });
    },
  }).visit(parsed.program);
  if (bindings.size === 0) return undefined;

  const results = new Map<string, SharedMutation[]>();
  for (const [legIndex, leg] of legs.entries()) {
    const legLabel = `${leg.mechanism}#${legIndex + 1}`;
    const writes = new Map<string, { source: string; guardBeforeWrite: boolean }>();
    new Visitor({
      AssignmentExpression(node) {
        if (!containsNode(leg.range, node)) return;
        const root = node.left.type === "Identifier"
          ? node.left.name
          : node.left.type === "MemberExpression"
            ? rootIdentifier(node.left)
            : undefined;
        if (!root || !bindings.has(root)) return;
        writes.set(root, { source: nodeSource(node, ownerFile.source), guardBeforeWrite: false });
      },
      UpdateExpression(node) {
        if (!containsNode(leg.range, node)) return;
        if (node.argument.type === "Identifier" && bindings.has(node.argument.name)) {
          writes.set(node.argument.name, { source: nodeSource(node, ownerFile.source), guardBeforeWrite: false });
        }
      },
      CallExpression(call) {
        if (!containsNode(leg.range, call)) return;
        if (call.callee.type !== "MemberExpression") return;
        const property = call.callee.property.type === "Identifier" ? call.callee.property.name : undefined;
        if (property !== "push" && property !== "set" && property !== "add") return;
        const root = rootIdentifier(call.callee);
        if (!root || !bindings.has(root)) return;
        writes.set(root, { source: nodeSource(call, ownerFile.source), guardBeforeWrite: false });
      },
      IfStatement(node) {
        if (!containsNode(leg.range, node)) return;
        const testSource = nodeSource(node.test, ownerFile.source);
        new Visitor({
          CallExpression(call) {
            if (!containsNode(node.consequent, call) && !containsNode(node.alternate ?? node.consequent, call)) return;
            if (call.callee.type !== "MemberExpression") return;
            const property = call.callee.property.type === "Identifier" ? call.callee.property.name : undefined;
            if (property !== "set" && property !== "add" && property !== "push") return;
            const root = rootIdentifier(call.callee);
            if (!root || !bindings.has(root)) return;
            if (testSource.includes(root)) {
              writes.set(root, { source: nodeSource(call, ownerFile.source), guardBeforeWrite: true });
            }
          },
        }).visit(parsed.program);
      },
    }).visit(parsed.program);
    for (const [bindingName, write] of writes) {
      const list = results.get(bindingName) ?? [];
      list.push({ leg: legLabel, source: write.source, checkThenAct: write.guardBeforeWrite });
      results.set(bindingName, list);
    }
  }

  const bindingsOut: MutatedBinding[] = [...results]
    .filter(([, mutations]) => {
      const distinctLegs = new Set(mutations.map(({ leg }) => leg));
      return distinctLegs.size >= 2 || mutations.some(({ checkThenAct }) => checkThenAct);
    })
    .map(([bindingName, mutations]) => ({
      name: bindingName,
      kind: bindings.get(bindingName)?.kind ?? ("let" as const),
      declaredIn: bindings.get(bindingName)?.declaredIn ?? ("closure" as const),
      mutations,
    }));
  if (bindingsOut.length === 0) return undefined;

  const signals: string[] = [];
  new Visitor({
    Identifier(node) {
      if (!containsNode(fn, node)) return;
      if (/mutex|Mutex|lock|Lock|Atomics|reduce|allSettled/i.test(node.name)) signals.push(node.name);
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
    scheduling: {
      mechanisms: [...new Set(legs.map(({ mechanism }) => mechanism))],
      legCount: legs.length,
    },
    bindings: bindingsOut,
    coordination: {
      hasAggregation: signals.some((signal) => /reduce|allSettled/i.test(signal)),
      signals: [...new Set(signals)],
    },
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(candidate.filePath, parsed.program, projectFiles),
    },
  };
}
