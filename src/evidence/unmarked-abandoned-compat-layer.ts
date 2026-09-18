import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallersWithCoverage,
  findModuleImporters,
  functionName,
  isFunctionExported,
  resolveModule,
  type FunctionNode,
} from "./repository.js";

export type CompatSuccessor = {
  name: string;
  filePath: string;
  useCount: number;
};

export type UnmarkedAbandonedCompatLayerEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  compatNaming: {
    matched: string[];
    inFunctionName: boolean;
    inFileName: boolean;
  };
  callerCount: number;
  successors: CompatSuccessor[];
  symbolImporters: string[];
  reexportPaths: string[];
};

const COMPAT_VOCABULARY = [
  "legacy",
  "compat",
  "v1",
  "old",
  "deprecated",
  "historic",
  "backcompat",
  "backward",
  "shim",
];

const MARKER_PATTERN = /@deprecated|@superseded/i;

function compatMatches(value: string): string[] {
  const lowered = value.toLowerCase();
  return COMPAT_VOCABULARY.filter((word) => {
    if (word === "v1" || word === "old") {
      return new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(lowered);
    }
    return lowered.includes(word);
  });
}

function nameTokens(name: string): string[] {
  return name
    .split(/(?<=[a-z])(?=[A-Z])|_+|-+|\s+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length >= 3);
}

function looksLikeSuccessor(oldName: string, newName: string): boolean {
  if (oldName === newName) return false;
  const oldTokens = new Set(nameTokens(oldName));
  if (oldTokens.size === 0) return false;
  if (nameTokens(newName).some((token) => oldTokens.has(token))) return true;
  const shorter = oldName.length <= newName.length ? oldName : newName;
  const longer = oldName.length <= newName.length ? newName : oldName;
  return shorter.length >= 4 && longer.toLowerCase().includes(shorter.toLowerCase());
}

function exportedFunctions(
  ownerPath: string,
  program: Program,
): { name: string; filePath: string }[] {
  const result: { name: string; filePath: string }[] = [];
  const consider = (node: FunctionNode): void => {
    const name = functionName(program, node);
    if (!name) return;
    if (!isFunctionExported(program, node, name)) return;
    if (result.some((entry) => entry.name === name)) return;
    result.push({ name, filePath: ownerPath });
  };
  new Visitor({
    ArrowFunctionExpression: consider,
    FunctionDeclaration: consider,
    FunctionExpression: consider,
  }).visit(program);
  return result;
}

function reexportPaths(
  ownerPath: string,
  name: string,
  projectFiles: ProjectFile[],
): string[] {
  const paths: string[] = [];
  for (const file of projectFiles) {
    if (file.filePath === ownerPath) continue;
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    for (const statement of parsed.program.body) {
      if (statement.type === "ExportAllDeclaration") {
        const resolved = resolveModule(file.filePath, statement.source.value, projectFiles);
        if (resolved?.filePath === ownerPath) paths.push(file.filePath);
      } else if (statement.type === "ExportNamedDeclaration" && statement.source) {
        const resolved = resolveModule(file.filePath, statement.source.value, projectFiles);
        if (resolved?.filePath !== ownerPath) continue;
        const names = statement.specifiers.map((specifier) => {
          if (specifier.local.type === "Identifier") return specifier.local.name;
          return specifier.exported.type === "Identifier" ? specifier.exported.name : "";
        });
        if (names.includes(name) || statement.specifiers.length === 0) paths.push(file.filePath);
      }
    }
  }
  return [...new Set(paths)].slice(0, 8);
}

export function buildUnmarkedAbandonedCompatLayerEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnmarkedAbandonedCompatLayerEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const inFunctionName = compatMatches(name);
  const inFileName = compatMatches(owner.filePath.split("/").pop() ?? "");
  const matched = [...new Set([...inFunctionName, ...inFileName])];
  if (matched.length === 0) return undefined;

  const markerWindow = owner.source.slice(Math.max(0, fn.start - 600), fn.start);
  if (MARKER_PATTERN.test(markerWindow)) return undefined;

  const callers = findFunctionCallersWithCoverage(owner.filePath, name, projectFiles);
  if (callers.total > 0) return undefined;

  const successors: CompatSuccessor[] = [];
  for (const file of projectFiles) {
    const fileParsed = parseCached(file.filePath, file.source);
    if (fileParsed.errors.some((error) => error.severity === "Error")) continue;
    for (const entry of exportedFunctions(file.filePath, fileParsed.program)) {
      if (entry.name === name) continue;
      if (!looksLikeSuccessor(name, entry.name)) continue;
      if (successors.some((existing) => existing.name === entry.name)) continue;
      const useCount = findFunctionCallersWithCoverage(
        file.filePath,
        entry.name,
        projectFiles,
      ).total;
      successors.push({ name: entry.name, filePath: entry.filePath, useCount });
      if (successors.length >= 5) break;
    }
    if (successors.length >= 5) break;
  }
  if (successors.length === 0) return undefined;

  const importers = findModuleImporters(owner.filePath, projectFiles)
    .filter(({ importedSymbols }) =>
      importedSymbols.includes(name) || importedSymbols.includes("default")
    )
    .map(({ filePath }) => filePath)
    .slice(0, 10);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    compatNaming: {
      matched,
      inFunctionName: inFunctionName.length > 0,
      inFileName: inFileName.length > 0,
    },
    callerCount: 0,
    successors,
    symbolImporters: importers,
    reexportPaths: reexportPaths(owner.filePath, name, projectFiles),
  };
}
