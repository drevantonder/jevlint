import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type {
  BindingPattern,
  Expression,
  MemberExpression,
  ParamPattern,
  Program,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type RuntimeInputKind =
  | "browser"
  | "environment"
  | "global-state"
  | "process"
  | "randomness"
  | "time";

type RuntimeInputEvidence = {
  kind: RuntimeInputKind;
  expression: string;
};

type LocatedRuntimeInput = RuntimeInputEvidence & {
  end: number;
  root: string;
  start: number;
};

export type HiddenRuntimeInputEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  runtimeInputs: RuntimeInputEvidence[];
  callers: FunctionCaller[];
};

function bindingNames(pattern: BindingPattern | ParamPattern): string[] {
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left);
  if (pattern.type === "RestElement") return bindingNames(pattern.argument);
  if (pattern.type === "TSParameterProperty") return bindingNames(pattern.parameter);
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.flatMap((element) => element ? bindingNames(element) : []);
  }
  return pattern.properties.flatMap((property) =>
    property.type === "RestElement" ? bindingNames(property.argument) : bindingNames(property.value),
  );
}

function memberPath(expression: Expression): string[] | undefined {
  if (expression.type === "Identifier") return [expression.name];
  if (expression.type === "ChainExpression") return memberPath(expression.expression);
  if (expression.type === "MetaProperty") {
    return [`${expression.meta.name}.${expression.property.name}`];
  }
  if (expression.type !== "MemberExpression") return undefined;
  const object = memberPath(expression.object);
  if (!object) return undefined;
  if (!expression.computed && expression.property.type === "Identifier") {
    return [...object, expression.property.name];
  }
  return object;
}

function inputKind(path: string[]): RuntimeInputKind | undefined {
  const [root, second, third] = path;
  if (root === "process" && second === "env") return "environment";
  if (root === "Deno" && second === "env") return "environment";
  if (root === "import.meta" && second === "env") return "environment";
  if (root === "process" && ["argv", "cwd", "pid", "platform"].includes(second ?? "")) {
    return "process";
  }
  if (
    (root === "Date" && second === "now")
    || (root === "performance" && second === "now")
  ) return "time";
  if (
    (root === "Math" && second === "random")
    || (root === "crypto" && ["getRandomValues", "randomUUID"].includes(second ?? ""))
  ) return "randomness";
  if (["document", "location", "navigator", "window"].includes(root ?? "")) return "browser";
  if (["localStorage", "sessionStorage"].includes(root ?? "") && second !== undefined) {
    return "browser";
  }
  if (root === "globalThis" && second !== undefined && third !== "undefined") {
    return "global-state";
  }
  return undefined;
}

function isDirectFunction(node: FunctionNode, target: FunctionNode): boolean {
  return node.start === target.start && node.end === target.end;
}

function runtimeInputs(
  ownerSource: string,
  program: Program,
  fn: FunctionNode,
): RuntimeInputEvidence[] {
  const located: LocatedRuntimeInput[] = [];
  const shadowed = new Set(fn.params.flatMap(bindingNames));
  let functionDepth = 0;

  const add = (
    expression: { start: number; end: number },
    path: string[],
    kind: RuntimeInputKind,
  ): void => {
    const root = path[0];
    if (!root || shadowed.has(root)) return;
    located.push({
      kind,
      expression: ownerSource.slice(expression.start, expression.end),
      root,
      start: expression.start,
      end: expression.end,
    });
  };
  const enterFunction = (node: FunctionNode): void => {
    if (isDirectFunction(node, fn)) {
      functionDepth = 1;
      return;
    }
    if (functionDepth === 0) return;
    if (functionDepth === 1 && node.id) shadowed.add(node.id.name);
    functionDepth += 1;
  };
  const exitFunction = (node: FunctionNode): void => {
    if (functionDepth === 0) return;
    functionDepth -= 1;
    if (isDirectFunction(node, fn)) functionDepth = 0;
  };

  new Visitor({
    ArrowFunctionExpression: enterFunction,
    "ArrowFunctionExpression:exit": exitFunction,
    FunctionDeclaration: enterFunction,
    "FunctionDeclaration:exit": exitFunction,
    FunctionExpression: enterFunction,
    "FunctionExpression:exit": exitFunction,
    VariableDeclarator(node) {
      if (functionDepth !== 1) return;
      for (const name of bindingNames(node.id)) shadowed.add(name);
    },
    MemberExpression(node: MemberExpression) {
      if (functionDepth !== 1) return;
      const path = memberPath(node);
      if (!path) return;
      const kind = inputKind(path);
      if (kind) add(node, path, kind);
    },
    CallExpression(node) {
      if (functionDepth !== 1) return;
      const path = memberPath(node.callee);
      if (!path) return;
      const kind = inputKind(path);
      if (kind) add(node, path, kind);
    },
    NewExpression(node) {
      if (
        functionDepth === 1
        && node.arguments.length === 0
        && node.callee.type === "Identifier"
        && node.callee.name === "Date"
        && !shadowed.has("Date")
      ) {
        add(node, ["Date"], "time");
      }
    },
  }).visit(program);

  const outermost = located.filter((input) => !located.some((other) =>
    input !== other
    && input.kind === other.kind
    && input.root === other.root
    && other.start <= input.start
    && other.end >= input.end,
  ));
  const unique = new Map<string, RuntimeInputEvidence>();
  for (const { kind, expression } of outermost) {
    unique.set(`${kind}:${expression}`, { kind, expression });
  }
  return [...unique.values()];
}

export function buildHiddenRuntimeInputEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HiddenRuntimeInputEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  const inputs = runtimeInputs(owner.source, parsed.program, fn);
  if (inputs.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    runtimeInputs: inputs,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
