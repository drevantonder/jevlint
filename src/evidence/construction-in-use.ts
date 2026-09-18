import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type InlineConstruction = {
  kind: "new" | "factory";
  classOrFactory: string;
  importSource: string | null;
  assignedTo: string | null;
  behaviorUse: "method-call" | "passed-as-argument" | "returned";
  line: number;
};

export type ConstructionInUseEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  constructions: InlineConstruction[];
  siblingInjection: {
    functionName: string;
    parameter: string;
  } | null;
  callersAlreadyHolding: {
    filePath: string;
    line: number;
    call: string;
  }[];
  callers: FunctionCaller[];
};

const CONSTRUCTOR_ROLE = /^(create|make|build|init|setup|configure|provide|get|use[A-Z]|open|connect|factory|provider|builder)/;
const FACTORY_CALL = /^(create|make|build|getDefault|getShared|getGlobal|open|connect|init|acquire)[A-Z0-9]/;

const VALUE_BUILTINS = new Set([
  "Object", "Array", "Map", "Set", "WeakMap", "WeakSet", "Date", "RegExp",
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
  "Promise", "Proxy", "URL", "URLSearchParams", "Headers", "Request",
  "Response", "FormData", "Number", "String", "Boolean", "BigInt",
  "ArrayBuffer", "DataView", "TextEncoder", "TextDecoder",
  "Int8Array", "Uint8Array", "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array", "Float32Array", "Float64Array",
]);

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function decapitalized(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

type RawConstruction = {
  kind: "new" | "factory";
  classOrFactory: string;
  start: number;
  end: number;
  line: number;
};

export function buildConstructionInUseEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ConstructionInUseEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  if (CONSTRUCTOR_ROLE.test(name)) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const own = (start: number, end: number): boolean => {
    if (start < fn.start || end > fn.end) return false;
    return !nested.some((range) => range.start <= start && range.end >= end);
  };

  const raw: RawConstruction[] = [];
  new Visitor({
    NewExpression(node) {
      if (!own(node.start, node.end)) return;
      if (node.callee.type !== "Identifier") return;
      if (VALUE_BUILTINS.has(node.callee.name)) return;
      if (!/^[A-Z]/.test(node.callee.name)) return;
      raw.push({
        kind: "new",
        classOrFactory: node.callee.name,
        start: node.start,
        end: node.end,
        line: lineAt(owner.source, node.start),
      });
    },
    CallExpression(node) {
      if (!own(node.start, node.end)) return;
      if (node.callee.type === "Identifier") {
        if (!FACTORY_CALL.test(node.callee.name)) return;
        raw.push({
          kind: "factory",
          classOrFactory: node.callee.name,
          start: node.start,
          end: node.end,
          line: lineAt(owner.source, node.start),
        });
      } else if (
        node.callee.type === "MemberExpression"
        && node.callee.object.type === "Identifier"
        && node.callee.property.type === "Identifier"
        && /^[A-Z]/.test(node.callee.object.name)
        && FACTORY_CALL.test(node.callee.property.name)
      ) {
        raw.push({
          kind: "factory",
          classOrFactory: `${node.callee.object.name}.${node.callee.property.name}`,
          start: node.start,
          end: node.end,
          line: lineAt(owner.source, node.start),
        });
      }
    },
  }).visit(parsed.program);
  if (raw.length === 0) return undefined;

  const bindings = new Map<string, string>();
  new Visitor({
    VariableDeclarator(node) {
      if (!own(node.start, node.end)) return;
      if (node.id.type !== "Identifier" || !node.init) return;
      for (const construction of raw) {
        if (node.init.start <= construction.start && node.init.end >= construction.end) {
          bindings.set(`${construction.start}:${construction.end}`, node.id.name);
        }
      }
    },
    AssignmentExpression(node) {
      if (!own(node.start, node.end)) return;
      if (node.left.type !== "Identifier") return;
      for (const construction of raw) {
        if (node.right.start <= construction.start && node.right.end >= construction.end) {
          bindings.set(`${construction.start}:${construction.end}`, node.left.name);
        }
      }
    },
  }).visit(parsed.program);

  const fnSource = owner.source.slice(fn.start, fn.end);
  const imports = moduleImports(parsed.program);
  const constructions: InlineConstruction[] = [];
  for (const construction of raw) {
    const assignedTo = bindings.get(`${construction.start}:${construction.end}`) ?? null;
    let behaviorUse: InlineConstruction["behaviorUse"] | null = null;
    if (assignedTo) {
      const escaped = assignedTo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp(`\\b${escaped}\\.[\\w$]+\\s*\\(`).test(fnSource)) {
        behaviorUse = "method-call";
      } else if (new RegExp(`\\breturn\\b[^;]*\\b${escaped}\\b`).test(fnSource)) {
        behaviorUse = "returned";
      } else if (new RegExp(`\\([\\s\\S]*\\b${escaped}\\b[\\s\\S]*\\)`).test(fnSource)) {
        behaviorUse = "passed-as-argument";
      }
    } else {
      const root = construction.classOrFactory.split(".")[0] ?? construction.classOrFactory;
      const escapedRoot = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`\\breturn\\s+new\\s+${escapedRoot}\\b`).test(fnSource)) {
        behaviorUse = "passed-as-argument";
      }
    }
    if (!behaviorUse) continue;
    const root = construction.classOrFactory.split(".")[0] ?? construction.classOrFactory;
    const importSource = imports.find((item) => item.local === root)?.source ?? null;
    constructions.push({
      kind: construction.kind,
      classOrFactory: construction.classOrFactory,
      importSource,
      assignedTo,
      behaviorUse,
      line: construction.line,
    });
  }
  if (constructions.length === 0) return undefined;

  let siblingInjection: ConstructionInUseEvidence["siblingInjection"] = null;
  const siblings: FunctionNode[] = [];
  new Visitor({
    ArrowFunctionExpression: (node) => {
      siblings.push(node);
    },
    FunctionDeclaration: (node) => {
      siblings.push(node);
    },
    FunctionExpression: (node) => {
      siblings.push(node);
    },
  }).visit(parsed.program);
  for (const construction of constructions) {
    const root = construction.classOrFactory.split(".")[0] ?? construction.classOrFactory;
    const wanted = decapitalized(root);
    for (const sibling of siblings) {
      if (sibling.start === fn.start && sibling.end === fn.end) continue;
      for (const parameter of sibling.params) {
        const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
        const text = owner.source.slice(value.start, value.end);
        const nameMatch = /\b([A-Za-z_$][\w$]*)\b/.exec(text);
        const paramName = nameMatch?.[1];
        if (!paramName) continue;
        if (
          paramName === wanted
          || root.endsWith(paramName.charAt(0).toUpperCase() + paramName.slice(1))
          || text.includes(root)
        ) {
          const siblingName = functionName(parsed.program, sibling) ?? "(anonymous)";
          siblingInjection = { functionName: siblingName, parameter: text.slice(0, 120) };
          break;
        }
      }
      if (siblingInjection) break;
    }
    if (siblingInjection) break;
  }

  const callers = findFunctionCallers(owner.filePath, name, projectFiles);
  const callersAlreadyHolding: ConstructionInUseEvidence["callersAlreadyHolding"] = [];
  for (const construction of constructions) {
    const root = construction.classOrFactory.split(".")[0] ?? construction.classOrFactory;
    const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`new\\s+${escaped}\\b|\\b${escaped}\\s*\\(`);
    for (const caller of callers) {
      if (pattern.test(caller.call) || caller.arguments.some((argument) => pattern.test(argument))) {
        callersAlreadyHolding.push({ filePath: caller.filePath, line: caller.line, call: caller.call });
      }
    }
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    constructions,
    siblingInjection,
    callersAlreadyHolding: callersAlreadyHolding.slice(0, 12),
    callers,
  };
}
