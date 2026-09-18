import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type UpwardImport = {
  source: string;
  resolved: string;
  layer: string;
  valueImport: boolean;
  importedSymbols: string[];
};

export type DomainUpwardImportEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    layer: string;
  };
  upwardImports: UpwardImport[];
  callers: FunctionCaller[];
};

const DOMAIN_PATTERN = /(^|\/)(domain|core|entities|models?)(\/|$)/i;
const OUTER_PATTERNS: { layer: string; pattern: RegExp }[] = [
  { layer: "adapter", pattern: /(^|\/)adapters?(\/|$)/i },
  { layer: "infrastructure", pattern: /(^|\/)infra(structure)?(\/|$)/i },
  { layer: "ui", pattern: /(^|\/)(ui|components?|pages?|views?|screens?|widgets?)(\/|$)/i },
  { layer: "route", pattern: /(^|\/)(routes?|controllers?|handlers?|endpoints?|api|http|web|delivery|presentation)(\/|$)/i },
  { layer: "app", pattern: /(^|\/)app(\/|$)/i },
];

function layerOf(filePath: string): string | null {
  for (const { layer, pattern } of OUTER_PATTERNS) {
    if (pattern.test(filePath)) return layer;
  }
  return null;
}

export function buildDomainUpwardImportEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DomainUpwardImportEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  if (!DOMAIN_PATTERN.test(candidate.filePath)) return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const upwardImports: UpwardImport[] = [];
  for (const statement of parsed.program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    if (statement.importKind === "type") continue;
    const resolved = resolveModule(owner.filePath, statement.source.value, projectFiles);
    if (!resolved) continue;
    const layer = layerOf(resolved.filePath);
    if (!layer) continue;
    upwardImports.push({
      source: statement.source.value,
      resolved: resolved.filePath,
      layer,
      valueImport: true,
      importedSymbols: statement.specifiers.map((specifier) => specifier.local.name).slice(0, 10),
    });
    if (upwardImports.length >= 8) break;
  }
  if (upwardImports.length === 0) {
    // Type-only upward edges are weaker but still structural; report them as non-value.
    for (const imported of moduleImports(parsed.program)) {
      if (upwardImports.length >= 8) break;
      const resolved = resolveModule(owner.filePath, imported.source, projectFiles);
      if (!resolved) continue;
      const layer = layerOf(resolved.filePath);
      if (!layer) continue;
      if (upwardImports.some((entry) => entry.resolved === resolved.filePath)) continue;
      upwardImports.push({
        source: imported.source,
        resolved: resolved.filePath,
        layer,
        valueImport: false,
        importedSymbols: [imported.imported],
      });
    }
  }
  if (upwardImports.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
      layer: "domain",
    },
    upwardImports,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
