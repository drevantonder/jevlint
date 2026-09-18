import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  abstractionName,
  findDirectAbstraction,
  findModuleImporters,
  isAbstractionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";

const VOLATILE_PATH_PATTERN = /(^|\/)(__tests__|__fixtures__|test|tests|testing|fixtures?|mocks?|stories|internal|private)(s?)\//i;
const VOLATILE_BASENAME_PATTERN = /[.](test|spec|fixture|mock|stories)[.][cm]?[jt]sx?$/i;

export type TargetVolatility = {
  importerCount: number;
  testOrFixturePath: boolean;
  internalPath: boolean;
  internalAnnotation: boolean;
};

export type StabilityDependency = {
  symbol: string;
  importedFrom: string;
  targetModule: string;
  targetImporters: string[];
  volatility: TargetVolatility;
};

export type StabilityInversionEvidence = {
  abstraction: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  ownerImporters: {
    count: number;
    files: string[];
  };
  dependencies: StabilityDependency[];
  direction: "stable-depends-on-volatile";
};

function programOf(filePath: string, source: string): Program | undefined {
  const parsed = parseCached(filePath, source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  return parsed.program;
}

function identifiersInRange(program: Program, start: number, end: number): string[] {
  const names: string[] = [];
  new Visitor({
    Identifier(node) {
      if (node.start >= start && node.end <= end && !names.includes(node.name)) {
        names.push(node.name);
      }
    },
  }).visit(program);
  return names;
}

export function buildStabilityInversionEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): StabilityInversionEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const program = programOf(owner.filePath, owner.source);
  if (!program) return undefined;
  const node = findDirectAbstraction(program, candidate);
  if (!node) return undefined;
  const name = abstractionName(program, node);

  const referenced = new Set(identifiersInRange(program, node.start, node.end));
  referenced.delete(name);
  if (referenced.size === 0) return undefined;

  const imports = moduleImports(program);
  const dependencies: StabilityDependency[] = [];
  for (const imported of imports) {
    if (!referenced.has(imported.local)) continue;
    const target = resolveModule(owner.filePath, imported.source, projectFiles);
    if (!target || target.filePath === owner.filePath) continue;
    if (dependencies.some((item) => item.targetModule === target.filePath)) continue;
    const targetImporters = findModuleImporters(target.filePath, projectFiles);
    const lowerPath = target.filePath.toLowerCase();
    dependencies.push({
      symbol: imported.local,
      importedFrom: imported.source,
      targetModule: target.filePath,
      targetImporters: targetImporters.map((item) => item.filePath).sort().slice(0, 8),
      volatility: {
        importerCount: targetImporters.length,
        testOrFixturePath: VOLATILE_PATH_PATTERN.test(target.filePath)
          || VOLATILE_BASENAME_PATTERN.test(target.filePath),
        internalPath: lowerPath.includes("internal") || lowerPath.includes("private"),
        internalAnnotation: target.source.includes("@internal"),
      },
    });
  }
  if (dependencies.length === 0) return undefined;

  const ownerImporters = findModuleImporters(owner.filePath, projectFiles);
  return {
    abstraction: {
      name,
      exported: isAbstractionExported(program, node, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    ownerImporters: {
      count: ownerImporters.length,
      files: ownerImporters.map((item) => item.filePath).sort().slice(0, 8),
    },
    dependencies,
    direction: "stable-depends-on-volatile",
  };
}
