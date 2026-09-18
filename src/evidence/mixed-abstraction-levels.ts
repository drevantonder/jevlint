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

export type AbstractionLevel = "mechanical" | "domain";

export type LevelSpan = {
  level: AbstractionLevel;
  kind: string;
  text: string;
  line: number;
};

export type MixedAbstractionLevelsEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  mechanical: LevelSpan[];
  domain: LevelSpan[];
  alternations: number;
  mechanicalRatio: number;
  wrappingHelper: string | null;
  importedSources: string[];
  callers: FunctionCaller[];
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

const MECHANICAL_CALLEES = new Set([
  "charAt",
  "charCodeAt",
  "codePointAt",
  "exec",
  "test",
  "match",
  "replace",
  "slice",
  "substring",
  "substr",
  "indexOf",
  "setUint8",
  "getUint8",
  "setInt32",
  "getInt32",
]);

function rootName(callee: string): string {
  const parts = callee.split(".");
  return parts[parts.length - 1] ?? callee;
}

function calleeText(source: string, start: number, end: number): string {
  return source.slice(start, end).slice(0, 120);
}

export function buildMixedAbstractionLevelsEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): MixedAbstractionLevelsEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const imports = moduleImports(parsed.program);
  const importedLocals = new Set(imports.map(({ local }) => local));
  const mechanical: LevelSpan[] = [];
  const domain: LevelSpan[] = [];
  const nested = nestedFunctionRanges(parsed.program, candidate);
  const own = (start: number, end: number): boolean => {
    if (start < fn.start || end > fn.end) return false;
    return !nested.some((range) => range.start <= start && range.end >= end);
  };

  const pushMechanical = (kind: string, start: number, end: number): void => {
    mechanical.push({
      level: "mechanical",
      kind,
      text: owner.source.slice(start, end).slice(0, 200),
      line: lineAt(owner.source, start),
    });
  };

  new Visitor({
    ForStatement(node) {
      if (!own(node.start, node.end)) return;
      const header = owner.source.slice(node.start, node.end).slice(0, 200);
      if (/;\s*[\w$[\]]+\s*(<|>|<=|>=|!==?)\s*[^;]+;\s*[^)]*(\+\+|--|\+=|-=)/.test(header)) {
        pushMechanical("counter-loop", node.start, node.end);
      }
    },
    WhileStatement(node) {
      if (!own(node.start, node.end)) return;
      pushMechanical("manual-loop", node.start, node.end);
    },
    BinaryExpression(node) {
      if (!own(node.start, node.end)) return;
      if (["<<", ">>", ">>>", "&", "|", "^"].includes(node.operator)) {
        pushMechanical("bitwise-operation", node.start, node.end);
      }
    },
    AssignmentExpression(node) {
      if (!own(node.start, node.end)) return;
      if (["<<=", ">>=", ">>>=", "&=", "|=", "^="].includes(node.operator)) {
        pushMechanical("bitwise-operation", node.start, node.end);
      }
    },
    CallExpression(node) {
      if (!own(node.start, node.end)) return;
      const text = calleeText(owner.source, node.callee.start, node.callee.end);
      const root = rootName(text);
      if (MECHANICAL_CALLEES.has(root)) {
        pushMechanical("plumbing-call", node.start, node.end);
        return;
      }
      if (/\b(Buffer|ArrayBuffer|DataView|Uint8Array|Int32Array)\b/.test(text)) {
        pushMechanical("buffer-manipulation", node.start, node.end);
        return;
      }
      const calleeRoot = text.split(/[.[(]/)[0]?.trim() ?? "";
      if (importedLocals.has(calleeRoot)) {
        domain.push({
          level: "domain",
          kind: "imported-collaborator",
          text: owner.source.slice(node.start, node.end).slice(0, 200),
          line: lineAt(owner.source, node.start),
        });
      }
    },
    NewExpression(node) {
      if (!own(node.start, node.end)) return;
      const text = calleeText(owner.source, node.callee.start, node.callee.end);
      if (/\b(Buffer|ArrayBuffer|DataView|Uint8Array|Int32Array)\b/.test(text)) {
        pushMechanical("buffer-manipulation", node.start, node.end);
      }
    },
  }).visit(parsed.program);

  if (mechanical.length === 0 || domain.length === 0) return undefined;

  const ordered = [...mechanical, ...domain].sort((left, right) => left.line - right.line);
  let alternations = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]?.level !== ordered[index - 1]?.level) alternations += 1;
  }
  const mechanicalRatio = mechanical.length / (mechanical.length + domain.length);

  const wrappingHelper = findWrappingHelper(parsed.program, fn, name, owner.source);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    mechanical: mechanical.slice(0, 12),
    domain: domain.slice(0, 12),
    alternations,
    mechanicalRatio,
    wrappingHelper,
    importedSources: [...new Set(imports.map(({ source }) => source))].slice(0, 12),
    callers: findFunctionCallers(owner.filePath, name, projectFiles),
  };
}

function findWrappingHelper(
  program: import("oxc-parser").Program,
  fn: FunctionNode,
  name: string,
  source: string,
): string | null {
  void fn;
  const helpers: string[] = [];
  new Visitor({
    FunctionDeclaration(node) {
      const helperName = node.id?.name;
      if (!helperName || helperName === name) return;
      const body = source.slice(node.start, node.end);
      if (/\bfor\s*\(|while\s*\(|charAt|ArrayBuffer|DataView|<<|>>/.test(body)) {
        helpers.push(helperName);
      }
    },
  }).visit(program);
  return helpers[0] ?? null;
}
