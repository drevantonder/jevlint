import { Visitor } from "oxc-parser";
import type { Program } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { moduleImports, resolveModule } from "./repository.js";
import {
  buildModuleEvidence,
  isFrameworkScaffolded,
  parseProgram,
} from "./module.js";
import type { ModuleEvidence } from "./module.js";

const SOURCE_CAP = 12;

export type ImportSourceSkew = {
  specifier: string;
  resolved: string | null;
  imported: string[];
  used: string[];
  unused: string[];
  ratio: number;
};

export type ImportUseSkewEvidence = {
  module: ModuleEvidence;
  sources: ImportSourceSkew[];
  heaviest: ImportSourceSkew;
};

function importRanges(program: Program): { start: number; end: number }[] {
  return program.body
    .filter((statement) => statement.type === "ImportDeclaration")
    .map((statement) => ({ start: statement.start, end: statement.end }));
}

function usedNames(program: Program, locals: Set<string>): Set<string> {
  const ranges = importRanges(program);
  const used = new Set<string>();
  new Visitor({
    Identifier(node) {
      if (!locals.has(node.name)) return;
      if (ranges.some((range) => range.start <= node.start && node.end <= range.end)) return;
      used.add(node.name);
    },
  }).visit(program);
  return used;
}

function isBarrel(program: Program): boolean {
  return program.body.some((statement) =>
    statement.type === "ExportAllDeclaration"
    || (statement.type === "ExportNamedDeclaration" && statement.source !== null)
  );
}

export function buildImportUseSkewEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): ImportUseSkewEvidence | undefined {
  if (candidate.kind !== "module") return undefined;
  if (isFrameworkScaffolded(candidate.filePath)) return undefined;
  const module = buildModuleEvidence(candidate.filePath, changes, projectFiles);
  if (!module) return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const program = parseProgram(owner.filePath, owner.source);
  if (!program) return undefined;
  if (isBarrel(program)) return undefined;

  const imports = moduleImports(program);
  if (imports.length === 0) return undefined;
  const locals = new Set(imports.map((item) => item.local));
  const used = usedNames(program, locals);

  const bySpecifier = new Map<string, string[]>();
  for (const item of imports) {
    const list = bySpecifier.get(item.source) ?? [];
    if (!list.includes(item.local)) list.push(item.local);
    bySpecifier.set(item.source, list);
  }

  const sources: ImportSourceSkew[] = [];
  for (const [specifier, names] of [...bySpecifier.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, SOURCE_CAP)) {
    const usedNamesFor = names.filter((name) => used.has(name)).sort();
    const unused = names.filter((name) => !used.has(name)).sort();
    sources.push({
      specifier,
      resolved: resolveModule(candidate.filePath, specifier, projectFiles)?.filePath ?? null,
      imported: [...names].sort(),
      used: usedNamesFor,
      unused,
      ratio: names.length === 0 ? 1 : usedNamesFor.length / names.length,
    });
  }
  if (!sources.some((source) => source.unused.length > 0)) return undefined;

  const heaviest = [...sources].sort((left, right) =>
    left.unused.length - right.unused.length
    || left.ratio - right.ratio
    || left.specifier.localeCompare(right.specifier)
  ).pop() ?? sources[0];
  if (!heaviest) return undefined;

  return { module, sources, heaviest };
}
