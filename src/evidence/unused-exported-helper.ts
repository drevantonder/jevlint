import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallersWithCoverage,
  findModuleImporters,
  functionName,
  isFunctionExported,
  resolveModule,
} from "./repository.js";

export type UnusedExportReexport = {
  reexported: boolean;
  reexportPaths: string[];
};

export type UnusedExportedHelperEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    startLine: number;
  };
  callerCount: number;
  callerExcerpts: string[];
  symbolImporters: string[];
  reexport: UnusedExportReexport;
  sameFileReferences: number;
  moduleInitSideEffects: string[];
  textualLeads: string[];
};

const MARKER_PATTERN = /@deprecated|@superseded/i;

const REGISTRATION_PATTERN =
  /@\w+|register\s*\(|provide\s*\(|inject\s*\(|app\s*\.\s*(?:get|post|put|patch|delete|use)\s*\(|router\s*\.\s*(?:get|post|put|patch|delete|use)\s*\(/;

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

function topLevelInitCalls(source: string, filePath: string): string[] {
  const parsed = parseCached(filePath, source);
  if (parsed.errors.some((error) => error.severity === "Error")) return [];
  const calls: string[] = [];
  for (const statement of parsed.program.body) {
    if (statement.type !== "ExpressionStatement") continue;
    const expression = statement.expression;
    if (expression.type === "CallExpression" || expression.type === "NewExpression") {
      calls.push(source.slice(expression.start, expression.end).slice(0, 160));
    }
    if (expression.type === "AssignmentExpression") {
      const right = expression.right;
      if (right.type === "CallExpression" || right.type === "NewExpression") {
        calls.push(source.slice(right.start, right.end).slice(0, 160));
      }
    }
  }
  return calls.slice(0, 8);
}

function sameFileReferences(
  source: string,
  name: string,
  fnStart: number,
  fnEnd: number,
): number {
  const pattern = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`, "g");
  let count = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index < fnStart || index >= fnEnd) count += 1;
  }
  return count;
}

function textualLeads(
  name: string,
  ownerPath: string,
  projectFiles: ProjectFile[],
): string[] {
  const namePattern = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`);
  const leads: string[] = [];
  for (const file of projectFiles) {
    for (const line of file.source.split("\n")) {
      if (!namePattern.test(line)) continue;
      const dynamicImport = new RegExp(`import\\s*\\([^)]*${name.replace(/\$/g, "\\$")}`).test(line);
      if (dynamicImport || REGISTRATION_PATTERN.test(line)) {
        leads.push(`${file.filePath}: ${line.trim().slice(0, 160)}`);
        if (leads.length >= 10) return leads;
      }
    }
  }
  if (leads.length > 0 || projectFiles.length === 0) return leads;
  const base = ownerPath.split("/").pop()?.replace(/\.(?:[cm]?[jt]sx?)$/, "") ?? "";
  if (base.length >= 3) {
    const basePattern = new RegExp(`import\\s*\\([^)]*${base.replace(/\$/g, "\\$")}`);
    for (const file of projectFiles) {
      for (const line of file.source.split("\n")) {
        if (basePattern.test(line)) {
          leads.push(`${file.filePath}: ${line.trim().slice(0, 160)}`);
          if (leads.length >= 10) return leads;
        }
      }
    }
  }
  return leads;
}

export function buildUnusedExportedHelperEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnusedExportedHelperEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  if (!isFunctionExported(parsed.program, fn, name)) return undefined;

  const markerWindow = owner.source.slice(Math.max(0, fn.start - 600), fn.start);
  if (MARKER_PATTERN.test(markerWindow)) return undefined;

  const coverage = findFunctionCallersWithCoverage(owner.filePath, name, projectFiles);
  if (coverage.total > 0) return undefined;

  const importers = findModuleImporters(owner.filePath, projectFiles)
    .filter(({ importedSymbols }) =>
      importedSymbols.includes(name) || importedSymbols.includes("default")
    )
    .map(({ filePath }) => filePath)
    .slice(0, 10);

  const paths = reexportPaths(owner.filePath, name, projectFiles);

  return {
    function: {
      name,
      exported: true,
      filePath: owner.filePath,
      source: candidate.source,
      startLine: candidate.startLine,
    },
    callerCount: 0,
    callerExcerpts: [],
    symbolImporters: importers,
    reexport: {
      reexported: paths.length > 0,
      reexportPaths: paths,
    },
    sameFileReferences: sameFileReferences(owner.source, name, fn.start, fn.end),
    moduleInitSideEffects: topLevelInitCalls(owner.source, owner.filePath),
    textualLeads: textualLeads(name, owner.filePath, projectFiles),
  };
}

