import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Node, Program } from "oxc-parser";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";
import type { Candidate, ProjectFile } from "../types.js";

const MAX_SIBLINGS = 6;
const MAX_CALLERS_PER_FUNCTION = 4;
const MAX_EXCERPT_CHARS = 800;

export type AbsenceSpelling =
  | "null"
  | "undefined"
  | "bare-return"
  | "envelope";

type ModuleFunction = {
  name: string;
  node: FunctionNode;
  exported: boolean;
};

export type SiblingAbsence = {
  name: string;
  exported: boolean;
  absenceSpelling: AbsenceSpelling;
  returnAnnotation: string | null;
  excerpt: string;
  callers: FunctionCaller[];
};

export type MixedAbsenceConventionEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    absenceSpelling: AbsenceSpelling;
    returnAnnotation: string | null;
  };
  siblings: SiblingAbsence[];
  sharedConvention: {
    hasSharedAbsenceType: boolean;
    detail: string | null;
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function moduleFunctions(program: Program): ModuleFunction[] {
  const functions: ModuleFunction[] = [];
  for (const statement of program.body) {
    const exported = statement.type === "ExportNamedDeclaration";
    const declaration = exported ? statement.declaration : statement;
    if (declaration?.type === "FunctionDeclaration") {
      const name = declaration.id?.name;
      if (name) functions.push({ name, node: declaration, exported });
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

function absenceSpellingFor(
  fn: FunctionNode,
  program: Program,
  source: string,
): AbsenceSpelling | undefined {
  const nested = nestedFunctionRanges(program, fn);
  let spelling: AbsenceSpelling | undefined;
  new Visitor({
    ReturnStatement(node) {
      if (spelling || !containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (!node.argument) {
        spelling = "bare-return";
        return;
      }
      const text = nodeSource(node.argument, source).trim();
      if (text === "null" || text.endsWith("?? null")) spelling = "null";
      else if (text === "undefined" || text.endsWith("?? undefined")) spelling = "undefined";
      else if (/\{\s*(ok|success)\s*:\s*false/.test(text)) spelling = "envelope";
    },
  }).visit(program);
  return spelling;
}

function returnAnnotation(fn: FunctionNode, source: string): string | null {
  const paramsEnd = fn.params.length > 0 ? fn.params[fn.params.length - 1]?.end : undefined;
  const bodyStart = fn.body?.start;
  if (paramsEnd === undefined || bodyStart === undefined) return null;
  const between = source.slice(paramsEnd, bodyStart);
  const match = /\)\s*:\s*(.+?)\s*(?:=>)?$/.exec(between.trim());
  return match?.[1]?.trim() ?? null;
}

function sharedAbsenceType(source: string): string | null {
  const match = /(?:type|interface)\s+(\w*(?:Option|Maybe|Optional)\w*)\s*[=<{]/.exec(source);
  if (match?.[1]) return `shared absence type ${match[1]}`;
  const nullCount = (source.match(/\|\s*null\b/g) ?? []).length;
  const undefinedCount = (source.match(/\|\s*undefined\b/g) ?? []).length;
  if (nullCount > 0 && undefinedCount === 0) return "module consistently annotates absence with | null";
  if (undefinedCount > 0 && nullCount === 0) {
    return "module consistently annotates absence with | undefined";
  }
  return null;
}

export function buildMixedAbsenceConventionEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): MixedAbsenceConventionEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const candidateSpelling = absenceSpellingFor(fn, parsed.program, owner.source);
  if (!candidateSpelling) return undefined;

  const siblings: SiblingAbsence[] = [];
  for (const other of moduleFunctions(parsed.program)) {
    if (other.name === name) continue;
    if (siblings.length >= MAX_SIBLINGS) break;
    const spelling = absenceSpellingFor(other.node, parsed.program, owner.source);
    if (!spelling || spelling === candidateSpelling) continue;
    siblings.push({
      name: other.name,
      exported: other.exported,
      absenceSpelling: spelling,
      returnAnnotation: returnAnnotation(other.node, owner.source),
      excerpt: owner.source.slice(other.node.start, other.node.end).slice(0, MAX_EXCERPT_CHARS),
      callers: findFunctionCallers(candidate.filePath, other.name, projectFiles)
        .slice(0, MAX_CALLERS_PER_FUNCTION),
    });
  }
  if (siblings.length === 0) return undefined;

  const shared = sharedAbsenceType(owner.source);
  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
      absenceSpelling: candidateSpelling,
      returnAnnotation: returnAnnotation(fn, owner.source),
    },
    siblings,
    sharedConvention: {
      hasSharedAbsenceType: shared !== null,
      detail: shared,
    },
  };
}
