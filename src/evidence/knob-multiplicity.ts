import { parseSync, Visitor } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { findDirectAbstraction } from "./repository.js";

export type KnobMechanismKind = "env" | "cli" | "config" | "parameter" | "flag";

export type KnobSiteEvidence = {
  filePath: string;
  snippet: string;
};

export type KnobMechanismEvidence = {
  kind: KnobMechanismKind;
  sites: KnobSiteEvidence[];
};

export type OrderingSiteEvidence = {
  filePath: string;
  name: string;
  source: string;
};

export type KnobMultiplicityEvidence = {
  concept: {
    name: string;
    stem: string;
    filePath: string;
    source: string;
  };
  mechanisms: KnobMechanismEvidence[];
  orderingSites: OrderingSiteEvidence[];
  coverage: {
    projectFiles: number;
  };
};

const OWNER_SUFFIXES = [
  "options",
  "option",
  "configuration",
  "config",
  "settings",
  "setting",
  "parameters",
  "params",
  "param",
  "args",
];

function conceptStem(name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const suffix of OWNER_SUFFIXES) {
    if (lower.length > suffix.length + 2 && lower.endsWith(suffix)) {
      return lower.slice(0, -suffix.length);
    }
  }
  return lower;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function boundedSnippet(source: string, index: number, length = 160): string {
  const start = Math.max(0, index - 60);
  return source.slice(start, Math.min(source.length, index + length)).trim();
}

function collectEnvSites(stem: string, projectFiles: ProjectFile[]): KnobSiteEvidence[] {
  const pattern = new RegExp(`\\bprocess\\.env\\.([A-Za-z_][A-Za-z0-9_]*)`, "g");
  const stemLower = stem.toLowerCase();
  const sites: KnobSiteEvidence[] = [];
  for (const file of projectFiles) {
    pattern.lastIndex = 0;
    let match = pattern.exec(file.source);
    while (match && sites.length < 5) {
      if (match[1]?.toLowerCase().includes(stemLower)) {
        sites.push({ filePath: file.filePath, snippet: boundedSnippet(file.source, match.index) });
      }
      match = pattern.exec(file.source);
    }
    if (sites.length >= 5) break;
  }
  return sites;
}

function collectCliSites(stem: string, projectFiles: ProjectFile[]): KnobSiteEvidence[] {
  const pattern = new RegExp(`--([a-z][a-z0-9-]*)`, "g");
  const stemLower = stem.toLowerCase();
  const sites: KnobSiteEvidence[] = [];
  for (const file of projectFiles) {
    pattern.lastIndex = 0;
    let match = pattern.exec(file.source);
    while (match && sites.length < 5) {
      if (match[1]?.toLowerCase().replace(/-/g, "").includes(stemLower)) {
        sites.push({ filePath: file.filePath, snippet: boundedSnippet(file.source, match.index) });
      }
      match = pattern.exec(file.source);
    }
    if (sites.length >= 5) break;
  }
  return sites;
}

function collectConfigSites(stem: string, projectFiles: ProjectFile[]): KnobSiteEvidence[] {
  const stemPattern = new RegExp(escapeRegExp(stem), "i");
  const sites: KnobSiteEvidence[] = [];
  for (const file of projectFiles) {
    const parsed = parseSync(file.filePath, file.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const members: { name: string; start: number }[] = [];
    new Visitor({
      TSInterfaceDeclaration(node) {
        for (const member of node.body.body) {
          if (member.type !== "TSPropertySignature" || member.computed) continue;
          if (member.key.type !== "Identifier") continue;
          members.push({ name: member.key.name, start: member.start });
        }
      },
      TSTypeAliasDeclaration(node) {
        if (node.typeAnnotation.type !== "TSTypeLiteral") return;
        for (const member of node.typeAnnotation.members) {
          if (member.type !== "TSPropertySignature" || member.computed) continue;
          if (member.key.type !== "Identifier") continue;
          members.push({ name: member.key.name, start: member.start });
        }
      },
    }).visit(parsed.program);
    for (const member of members) {
      if (sites.length >= 5) break;
      if (stemPattern.test(member.name)) {
        sites.push({ filePath: file.filePath, snippet: boundedSnippet(file.source, member.start) });
      }
    }
    if (sites.length >= 5) break;
  }
  return sites;
}

function collectParameterSites(stem: string, projectFiles: ProjectFile[]): KnobSiteEvidence[] {
  const stemLower = stem.toLowerCase();
  const sites: KnobSiteEvidence[] = [];
  for (const file of projectFiles) {
    const parsed = parseSync(file.filePath, file.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const addParams = (node: { params: { start: number; end: number }[] }): void => {
      for (const parameter of node.params) {
        if (sites.length >= 5) return;
        const source = file.source.slice(parameter.start, parameter.end);
        const names = source.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
        if (names.some((name) => name.toLowerCase().includes(stemLower))) {
          sites.push({ filePath: file.filePath, snippet: boundedSnippet(file.source, parameter.start) });
        }
      }
    };
    new Visitor({
      ArrowFunctionExpression: addParams,
      FunctionDeclaration: addParams,
      FunctionExpression: addParams,
    }).visit(parsed.program);
    if (sites.length >= 5) break;
  }
  return sites;
}

function collectFlagSites(stem: string, projectFiles: ProjectFile[]): KnobSiteEvidence[] {
  const pattern = new RegExp(
    `["']([^"']*(?:feature|enable|disable)[^"']*${escapeRegExp(stem)}[^"']*|[^"']*${escapeRegExp(stem)}[^"']*(?:feature|enable|disable)[^"']*)["']|\\b((?:is|should|use|enable)[A-Z][A-Za-z0-9]*${escapeRegExp(stem)}[A-Za-z0-9]*|${escapeRegExp(stem)}[A-Za-z0-9]*(?:Enabled|Disabled|Flag))\\b`,
    "gi",
  );
  const sites: KnobSiteEvidence[] = [];
  for (const file of projectFiles) {
    pattern.lastIndex = 0;
    let match = pattern.exec(file.source);
    while (match && sites.length < 5) {
      sites.push({ filePath: file.filePath, snippet: boundedSnippet(file.source, match.index) });
      match = pattern.exec(file.source);
    }
    if (sites.length >= 5) break;
  }
  return sites;
}

function collectOrderingSites(
  knobSpellings: string[],
  projectFiles: ProjectFile[],
): OrderingSiteEvidence[] {
  const patterns = knobSpellings.map((spelling) => new RegExp(`\\b${escapeRegExp(spelling)}\\b`));
  const sites: OrderingSiteEvidence[] = [];
  for (const file of projectFiles) {
    const parsed = parseSync(file.filePath, file.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    new Visitor({
      FunctionDeclaration(node) {
        if (sites.length >= 5) return;
        const source = file.source.slice(node.start, node.end);
        const hits = patterns.filter((pattern) => pattern.test(source)).length;
        if (hits >= 2) {
          sites.push({
            filePath: file.filePath,
            name: node.id?.name ?? "(anonymous)",
            source: source.slice(0, 4_000),
          });
        }
      },
    }).visit(parsed.program);
    if (sites.length >= 5) break;
  }
  return sites;
}

function knobSpellings(stem: string, mechanisms: KnobMechanismEvidence[]): string[] {
  const stemLower = stem.toLowerCase();
  const spellings = new Set<string>();
  for (const mechanism of mechanisms) {
    for (const site of mechanism.sites) {
      for (const word of site.snippet.match(/[A-Za-z_][A-Za-z0-9_-]*/g) ?? []) {
        if (word.toLowerCase().includes(stemLower)) spellings.add(word);
      }
    }
  }
  return [...spellings].slice(0, 20);
}

export function buildKnobMultiplicityEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): KnobMultiplicityEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const declaration = findDirectAbstraction(parsed.program, candidate);
  if (!declaration) return undefined;
  const stem = conceptStem(declaration.id.name);
  if (!stem || stem.length < 3) return undefined;

  const configured: KnobMechanismEvidence[] = [
    { kind: "env", sites: collectEnvSites(stem, projectFiles) },
    { kind: "cli", sites: collectCliSites(stem, projectFiles) },
    { kind: "config", sites: collectConfigSites(stem, projectFiles) },
    { kind: "parameter", sites: collectParameterSites(stem, projectFiles) },
    { kind: "flag", sites: collectFlagSites(stem, projectFiles) },
  ];
  const mechanisms = configured.filter((mechanism) => mechanism.sites.length > 0);
  if (mechanisms.length < 3) return undefined;

  return {
    concept: {
      name: declaration.id.name,
      stem,
      filePath: owner.filePath,
      source: candidate.source,
    },
    mechanisms,
    orderingSites: collectOrderingSites(knobSpellings(stem, mechanisms), projectFiles),
    coverage: {
      projectFiles: projectFiles.length,
    },
  };
}
