import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isInsideNestedFunction,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionNode } from "./repository.js";
import { isTestFileContent } from "./test-signals.js";
import { isTestFilePath } from "./test-scope.js";

export type SingletonGrabEvidence = {
  module: string;
  local: string;
  expression: string;
};

export type UntestableSingletonGrabEvidence = {
  function: {
    name: string | null;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  grabs: SingletonGrabEvidence[];
  parameters: string[];
  injectedViaParam: boolean;
  likelyWiring: boolean;
  callers: { filePath: string; call: string; line: number }[];
  testDoubleFiles: string[];
};

const SINGLETON_HINT =
  /store|singleton|database|\bdb\b|dao|repository|\brepo\b|client|connection|\bpool\b|cache|queue|\bbus\b|broker|container|registry|locator|instance|gateway|\bsdk\b|prisma|\borm\b|stripe|twilio|contentful|sanity/i;

function isSingletonImport(source: string, local: string, imported: string): boolean {
  if (SINGLETON_HINT.test(source)) return true;
  if (SINGLETON_HINT.test(local)) return true;
  if (/^(default|\*)$/.test(imported) && SINGLETON_HINT.test(local)) return true;
  return /^get[A-Z].*(Store|Db|Database|Client|Instance|Connection|Pool|Cache|Queue|Container)$/.test(
    imported,
  );
}

function parameterNames(fn: FunctionNode): string[] {
  const names: string[] = [];
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    if (value.type === "Identifier") {
      names.push(value.name);
      continue;
    }
    if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
      names.push(value.left.name);
      continue;
    }
    if (value.type === "RestElement" && value.argument.type === "Identifier") {
      names.push(value.argument.name);
      continue;
    }
    if (value.type === "ObjectPattern") {
      for (const property of value.properties) {
        if (property.type === "Property" && property.value.type === "Identifier") {
          names.push(property.value.name);
        } else if (property.type === "RestElement" && property.argument.type === "Identifier") {
          names.push(property.argument.name);
        }
      }
    }
  }
  return [...new Set(names)];
}

export function buildUntestableSingletonGrabEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UntestableSingletonGrabEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  if (isTestFilePath(candidate.filePath, projectFiles)) return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const singletonLocals = new Map<string, string>();
  for (const statement of parsed.program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const source = statement.source.value;
    for (const specifier of statement.specifiers) {
      if (specifier.type !== "ImportSpecifier" && specifier.type !== "ImportDefaultSpecifier") {
        continue;
      }
      if (statement.importKind === "type") continue;
      if (specifier.type === "ImportSpecifier" && specifier.importKind === "type") continue;
      const local = specifier.local.name;
      const imported = specifier.type === "ImportSpecifier"
        ? (specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value)
        : "default";
      if (isSingletonImport(source, local, imported)) {
        singletonLocals.set(local, source);
      }
    }
  }
  if (singletonLocals.size === 0) return undefined;

  const grabs: SingletonGrabEvidence[] = [];
  const seen = new Set<number>();
  const typeRanges: { start: number; end: number }[] = [];
  new Visitor({
    TSTypeAnnotation(node) {
      typeRanges.push({ start: node.start, end: node.end });
    },
    TSTypeQuery(node) {
      typeRanges.push({ start: node.start, end: node.end });
    },
  }).visit(parsed.program);
  const nested = nestedFunctionRanges(parsed.program, candidate);
  new Visitor({
    Identifier(node) {
      if (node.start < fn.start || node.end > fn.end) return;
      if (isInsideNestedFunction(node, nested)) return;
      if (typeRanges.some((range) => range.start <= node.start && range.end >= node.end)) return;
      const module = singletonLocals.get(node.name);
      if (!module) return;
      if (seen.has(node.start)) return;
      seen.add(node.start);
      const expression = owner.source.slice(
        Math.max(fn.start, node.start - 80),
        Math.min(fn.end, node.end + 120),
      ).replaceAll(/\s+/g, " ").slice(0, 300);
      grabs.push({ module, local: node.name, expression });
    },
  }).visit(parsed.program);

  if (grabs.length === 0) return undefined;

  const params = parameterNames(fn);
  const injectedViaParam = [...singletonLocals.keys()].some((local) => params.includes(local));
  const name = functionName(parsed.program, fn) ?? null;
  const likelyWiring = /wiring|composition|bootstrap|di\b|container|server|app|index|startup/i.test(
    candidate.filePath,
  ) || (name !== null && /^(wire|bootstrap|compose|init|create[A-Z].*App|start)/.test(name));
  const callers = name
    ? findFunctionCallers(owner.filePath, name, projectFiles).map(({ filePath, call, line }) => ({
      filePath,
      call: call.slice(0, 300),
      line,
    }))
    : [];

  const testDoubleFiles: string[] = [];
  for (const file of projectFiles) {
    if (!isTestFileContent(file.filePath, file.source)) continue;
    const mentionsModule = [...singletonLocals.values()].some((module) => {
      const base = module.split("/").pop() ?? module;
      return file.source.includes(module) || (base.length > 2 && file.source.includes(base));
    });
    if (!mentionsModule) continue;
    if (/vi\s*\.\s*mock|jest\s*\.\s*mock|mock\s*\(|stub\s*\(|fake\s*\(|createStub|sandbox/i.test(file.source)) {
      testDoubleFiles.push(file.filePath);
    }
  }

  return {
    function: {
      name,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    grabs: grabs.slice(0, 10),
    parameters: params,
    injectedViaParam,
    likelyWiring,
    callers: callers.slice(0, 10),
    testDoubleFiles: testDoubleFiles.slice(0, 10),
  };
}
