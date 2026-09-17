import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { manifestDependencies } from "./repository.js";

export type AddedDependencyUse = {
  name: string;
  version: string;
  importSites: string[];
  importLines: string[];
  usedMembers: string[];
  platformEquivalent: string | null;
};

export type SingleUseDependencyEvidence = {
  manifest: {
    filePath: string;
    addedDependencies: string[];
  };
  added: AddedDependencyUse[];
};

type PlatformEquivalent = {
  dependency: string;
  equivalent: string;
};

const PLATFORM_EQUIVALENTS: PlatformEquivalent[] = [
  { dependency: "uuid", equivalent: "crypto.randomUUID()" },
  { dependency: "nanoid", equivalent: "crypto.randomUUID()" },
  { dependency: "lodash", equivalent: "native Array/Object methods and optional chaining" },
  { dependency: "lodash.isempty", equivalent: "optional chaining and native length checks" },
  { dependency: "axios", equivalent: "global fetch" },
  { dependency: "got", equivalent: "global fetch" },
  { dependency: "node-fetch", equivalent: "global fetch" },
  { dependency: "moment", equivalent: "Intl and native Date" },
  { dependency: "qs", equivalent: "URLSearchParams" },
  { dependency: "rimraf", equivalent: "fs.rm with recursive" },
  { dependency: "mkdirp", equivalent: "fs.mkdir with recursive" },
  { dependency: "chalk", equivalent: "plain output without color" },
  { dependency: "leftpad", equivalent: "String.prototype.padStart" },
  { dependency: "isodd", equivalent: "a modulo expression" },
  { dependency: "isnumber", equivalent: "typeof checks" },
];

function platformEquivalent(name: string): string | null {
  return PLATFORM_EQUIVALENTS.find((entry) => entry.dependency === name)?.equivalent ?? null;
}

function importLinesFor(specifier: string, source: string): string[] {
  const lines = source.split("\n");
  return lines
    .filter((line) =>
      line.includes(`from "${specifier}"`)
      || line.includes(`from '${specifier}'`)
      || line.includes(`require("${specifier}")`)
      || line.includes(`require('${specifier}')`)
    )
    .map((line) => line.trim().slice(0, 200));
}

function importedLocals(lines: string[]): string[] {
  const locals: string[] = [];
  for (const line of lines) {
    const named = /import\s*\{([^}]*)\}\s*from/.exec(line);
    if (named?.[1]) {
      for (const part of named[1].split(",")) {
        const local = part.split("as").pop()?.trim();
        if (local) locals.push(local);
      }
    }
    const single = /import\s+([A-Za-z_$][\w$]*)\s+from/.exec(line);
    if (single?.[1]) locals.push(single[1]);
    const required = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(/.exec(line);
    if (required?.[1]) locals.push(required[1]);
  }
  return [...new Set(locals)];
}

function usedMembers(locals: string[], projectFiles: ProjectFile[]): string[] {
  const members = new Set<string>();
  for (const file of projectFiles) {
    if (/(^|\/)package\.json$/.test(file.filePath)) continue;
    for (const local of locals) {
      const pattern = new RegExp(`\\b${local.replace(/\$/g, "\\$")}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, "g");
      for (const match of file.source.matchAll(pattern)) {
        if (match[1]) members.add(match[1]);
      }
    }
  }
  return [...members].slice(0, 10);
}

export function buildSingleUseDependencyEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): SingleUseDependencyEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  const manifestChange = changes.find((change) =>
    /(^|\/)package\.json$/.test(change.filePath) && change.oldSource !== null
  );
  if (!manifestChange?.oldSource) return undefined;

  const before = manifestDependencies(manifestChange.oldSource);
  const after = manifestDependencies(manifestChange.source);
  const addedNames = after.filter((entry) => !before.some((item) => item.name === entry.name));
  if (addedNames.length === 0) return undefined;

  const added: AddedDependencyUse[] = addedNames.map((entry) => {
    const sites = projectFiles.filter((file) => importLinesFor(entry.name, file.source).length > 0);
    const lines = sites.flatMap((file) => importLinesFor(entry.name, file.source)).slice(0, 5);
    return {
      name: entry.name,
      version: entry.version,
      importSites: sites.map((file) => file.filePath).slice(0, 10),
      importLines: lines,
      usedMembers: usedMembers(importedLocals(lines), projectFiles),
      platformEquivalent: platformEquivalent(entry.name),
    };
  });

  return {
    manifest: {
      filePath: manifestChange.filePath,
      addedDependencies: addedNames.map((entry) => entry.name),
    },
    added: added.slice(0, 10),
  };
}
