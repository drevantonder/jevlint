import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findModuleImporters,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionNode, ModuleImporter } from "./repository.js";

const MAX_SIBLINGS = 8;
const MAX_EXCERPT_CHARS = 500;

const CALLBACK_PARAM_PATTERN = /^(cb|callback|done|next)$/i;
const HANDLER_PARAM_PATTERN = /^on[A-Z_]/;
const CALLBACK_TYPE_PATTERN = /=>|\bFunction\b|\bCallback\b|\bHandler\b/;

export type CompletionStyle = "callback" | "return";

export type CompletionSibling = {
  name: string;
  exported: boolean;
  style: CompletionStyle;
  callbackParameters: string[];
  isAsync: boolean;
  excerpt: string;
};

export type CallbackReturnSplitEvidence = {
  function: {
    name: string;
    exported: boolean;
    style: CompletionStyle;
    callbackParameters: string[];
    isAsync: boolean;
    filePath: string;
    source: string;
  };
  moduleStyle: {
    majority: CompletionStyle;
    callbackCount: number;
    returnCount: number;
  };
  siblings: CompletionSibling[];
  callbackStyleClients: ModuleImporter[];
  returnStyleClients: ModuleImporter[];
  migrationSuffixedName: boolean;
};

function bindingName(parameter: FunctionNode["params"][number]): string | undefined {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  if (value.type === "Identifier") return value.name;
  if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
    return value.left.name;
  }
  if (value.type === "RestElement" && value.argument.type === "Identifier") {
    return value.argument.name;
  }
  return undefined;
}

function callbackParameters(fn: FunctionNode, source: string): string[] {
  const result: string[] = [];
  for (const parameter of fn.params) {
    const name = bindingName(parameter);
    if (name === undefined) continue;
    const text = source.slice(parameter.start, parameter.end);
    if (
      CALLBACK_PARAM_PATTERN.test(name)
      || HANDLER_PARAM_PATTERN.test(name)
      || CALLBACK_TYPE_PATTERN.test(text)
    ) result.push(name);
  }
  return result;
}

type CompletionClassification = {
  style: CompletionStyle;
  callbackParameters: string[];
  isAsync: boolean;
};

function completionStyle(fn: FunctionNode, source: string): CompletionClassification {
  const found = callbackParameters(fn, source);
  return {
    style: found.length > 0 ? "callback" : "return",
    callbackParameters: found,
    isAsync: fn.async === true,
  };
}

type NamedFunction = {
  name: string;
  node: FunctionNode;
  exported: boolean;
};

function moduleFunctions(
  program: ReturnType<typeof parseCached>["program"],
): NamedFunction[] {
  const functions: NamedFunction[] = [];
  for (const statement of program.body) {
    const exported = statement.type === "ExportNamedDeclaration"
      || statement.type === "ExportDefaultDeclaration";
    const declaration = statement.type === "ExportNamedDeclaration"
      || statement.type === "ExportDefaultDeclaration"
      ? statement.declaration
      : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.id?.name) {
      functions.push({ name: declaration.id.name, node: declaration, exported });
      continue;
    }
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const item of declaration.declarations) {
      if (item.id.type !== "Identifier" || !item.init) continue;
      if (
        item.init.type === "ArrowFunctionExpression"
        || item.init.type === "FunctionExpression"
      ) functions.push({ name: item.id.name, node: item.init, exported });
    }
  }
  return functions;
}

export function buildCallbackReturnSplitEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): CallbackReturnSplitEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const self = completionStyle(fn, owner.source);
  const siblings: CompletionSibling[] = [];
  let callbackCount = 0;
  let returnCount = 0;
  for (const other of moduleFunctions(parsed.program)) {
    if (other.name === name && other.node.start === fn.start && other.node.end === fn.end) continue;
    const classified = completionStyle(other.node, owner.source);
    if (classified.style === "callback") callbackCount += 1;
    else returnCount += 1;
    if (siblings.length >= MAX_SIBLINGS) continue;
    siblings.push({
      name: other.name,
      exported: other.exported,
      style: classified.style,
      callbackParameters: classified.callbackParameters,
      isAsync: classified.isAsync,
      excerpt: owner.source.slice(other.node.start, other.node.end).slice(0, MAX_EXCERPT_CHARS),
    });
  }
  if (self.style === "callback") callbackCount += 1;
  else returnCount += 1;

  // A lone export contradicts no convention; the proposition needs a
  // surrounding surface with at least one sibling on the other style.
  if (callbackCount + returnCount < 2) return undefined;
  if (!siblings.some((sibling) => sibling.style !== self.style)) return undefined;

  const majority: CompletionStyle = callbackCount >= returnCount ? "callback" : "return";
  const styleOf = new Map(siblings.map((sibling) => [sibling.name, sibling.style]));
  styleOf.set(name, self.style);
  const callbackStyleClients: ModuleImporter[] = [];
  const returnStyleClients: ModuleImporter[] = [];
  for (const importer of findModuleImporters(owner.filePath, projectFiles)) {
    const styles = new Set(
      importer.importedSymbols.flatMap((symbol) => {
        const style = styleOf.get(symbol);
        return style === undefined ? [] : [style];
      }),
    );
    if (styles.has("callback")) callbackStyleClients.push(importer);
    if (styles.has("return")) returnStyleClients.push(importer);
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      style: self.style,
      callbackParameters: self.callbackParameters,
      isAsync: self.isAsync,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    moduleStyle: { majority, callbackCount, returnCount },
    siblings,
    callbackStyleClients,
    returnStyleClients,
    migrationSuffixedName: /(Async|Sync|Callback|Promise)$/.test(name),
  };
}
