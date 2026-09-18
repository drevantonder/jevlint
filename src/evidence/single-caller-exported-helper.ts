import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallersAndReferencesWithCoverage,
  findModuleImporters,
  functionName,
  isFunctionExported,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";
import { partitionCallersByTest } from "./test-scope.js";

export type SingleCallerReexport = {
  reexported: boolean;
  reexportPaths: string[];
};

export type SingleCallerExportedHelperEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    paramCount: number;
  };
  totalCallers: number;
  caller: FunctionCaller;
  callerOwnership: "same-file" | "importing-module" | "unresolved";
  testCallers: FunctionCaller[];
  testCallerCount: number;
  reexport: SingleCallerReexport;
};

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

export function buildSingleCallerExportedHelperEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): SingleCallerExportedHelperEvidence | undefined {
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

  // A lone reference-as-value (`const g = fn`) is still exactly one
  // production consumer, so it lands in the single-caller seam as the caller.
  const coverage = findFunctionCallersAndReferencesWithCoverage(
    owner.filePath,
    name,
    projectFiles,
    { start: fn.start, end: fn.end },
  );
  const { production, test } = partitionCallersByTest(coverage.callers);
  if (production.length !== 1) return undefined;
  const caller = production[0];
  if (!caller) return undefined;

  const ownership: SingleCallerExportedHelperEvidence["callerOwnership"] =
    caller.filePath === owner.filePath
      ? "same-file"
      : findModuleImporters(owner.filePath, projectFiles).some(({ filePath }) => filePath === caller.filePath)
        ? "importing-module"
        : "unresolved";

  const paths = reexportPaths(owner.filePath, name, projectFiles);

  return {
    function: {
      name,
      exported: true,
      filePath: owner.filePath,
      source: candidate.source,
      paramCount: fn.params.length,
    },
    totalCallers: production.length,
    caller,
    callerOwnership: ownership,
    testCallers: test.slice(0, 10),
    testCallerCount: test.length,
    reexport: {
      reexported: paths.length > 0,
      reexportPaths: paths,
    },
  };
}
