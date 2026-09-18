import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findModuleImporters,
  functionName,
  isFunctionExported,
} from "./repository.js";

export type RetainedSupersededImplementationEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  marker: {
    tag: string;
    note: string;
    successor: string | null;
  };
  callerCount: number;
  symbolImporters: string[];
  successor: {
    name: string | null;
    useCount: number;
    files: string[];
  };
};

const TAG_PATTERN = /@deprecated[^\n*]{0,200}|@superseded[^\n*]{0,200}/i;
const SUPERSEDED_BY_PATTERN = /superseded\s+by\s+([A-Za-z_$][\w$.]*)/i;
const USE_INSTEAD_PATTERN = /\buse\s+([A-Za-z_$][\w$.]*)\s+instead\b/i;
const USE_PATTERN = /\buse\s+([A-Za-z_$][\w$.]*)/i;

function markerBefore(source: string, start: number): { tag: string; note: string } | undefined {
  const window = source.slice(Math.max(0, start - 600), start);
  const match = TAG_PATTERN.exec(window);
  if (!match) return undefined;
  const note = match[0].trim().slice(0, 200);
  const tag = /^@\w+/.exec(note)?.[0] ?? "@deprecated";
  return { tag, note };
}

function successorFrom(window: string, note: string): string | null {
  const superseded = SUPERSEDED_BY_PATTERN.exec(window);
  if (superseded?.[1]) return superseded[1];
  const instead = USE_INSTEAD_PATTERN.exec(window);
  if (instead?.[1]) return instead[1];
  const use = USE_PATTERN.exec(note);
  return use?.[1] ?? null;
}

function successorFiles(
  successor: string,
  ownerPath: string,
  projectFiles: ProjectFile[],
): string[] {
  const leaf = successor.split(".").pop() ?? successor;
  const pattern = new RegExp(`\\b${leaf.replace(/\$/g, "\\$")}\\b`);
  return projectFiles
    .filter((file) => file.filePath !== ownerPath && pattern.test(file.source))
    .map((file) => file.filePath)
    .slice(0, 10);
}

export function buildRetainedSupersededImplementationEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): RetainedSupersededImplementationEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const window = owner.source.slice(Math.max(0, fn.start - 600), fn.start);
  const found = markerBefore(owner.source, fn.start);
  if (!found) return undefined;
  const successor = successorFrom(window, found.note);
  const marker = { ...found, successor };

  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);
  if (callers.length > 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    marker,
    callerCount: 0,
    symbolImporters: findModuleImporters(candidate.filePath, projectFiles)
      .filter(({ importedSymbols }) =>
        importedSymbols.includes(name) || importedSymbols.includes("default")
      )
      .map(({ filePath }) => filePath)
      .slice(0, 10),
    successor: {
      name: successor,
      useCount: successor ? successorFiles(successor, candidate.filePath, projectFiles).length : 0,
      files: successor ? successorFiles(successor, candidate.filePath, projectFiles) : [],
    },
  };
}
