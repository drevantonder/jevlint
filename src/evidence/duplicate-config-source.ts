import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";import { moduleImports, resolveModule } from "./repository.js";

export type ConfigChannelKind = "env-read" | "dotenv-init" | "config-file-load" | "flag-parser";

export type NewConfigRead = {
  filePath: string;
  expression: string;
  kind: ConfigChannelKind;
  line: number;
};

export type OwnedConfigModule = {
  filePath: string;
  importedBy: string[];
};

export type DuplicateConfigSourceEvidence = {
  anchorFile: string;
  coverage: {
    totalFiles: number;
    comparedFiles: number;
  };
  newReads: NewConfigRead[];
  ownedModule: OwnedConfigModule | null;
  delegatesToOwned: boolean;
  ownedChannelUsers: number;
  directEnvUsers: number;
};

const CONFIG_DIR_PATTERN = /(^|\/)(config|settings)(\/|$)/;
const ENV_READ_PATTERN = /process\.env(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])|Deno\.env\.get|import\.meta\.env\b/;
const DOTENV_PATTERN = /dotenv\s*\.\s*config|require\(["']dotenv["']\)/;
const CONFIG_FILE_LOAD_PATTERN = /readFileSync\s*\([^)]*\.(ya?ml|toml|json|ini)|yaml\s*\.\s*load|parse\s*\(\s*\w*[Cc]onfig|loadConfig|cosmiconfig/i;
const FLAG_PARSER_PATTERN = /commander|yargs|minimist|parseArgs|getenv\s*\(/i;

function changedLineSet(change: SourceFile): Set<number> {
  const lines = new Set<number>();
  for (const range of change.changedLines) {
    for (let line = range.start; line <= range.end; line += 1) lines.add(line);
  }
  return lines;
}

function kindOf(text: string): ConfigChannelKind | null {
  if (DOTENV_PATTERN.test(text)) return "dotenv-init";
  if (ENV_READ_PATTERN.test(text)) return "env-read";
  if (CONFIG_FILE_LOAD_PATTERN.test(text)) return "config-file-load";
  if (FLAG_PARSER_PATTERN.test(text)) return "flag-parser";
  return null;
}

function findOwnedModule(projectFiles: ProjectFile[]): OwnedConfigModule | null {
  const candidates = new Map<string, string[]>();
  for (const file of projectFiles) {
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    for (const imported of moduleImports(parsed.program)) {
      const resolved = resolveModule(file.filePath, imported.source, projectFiles);
      if (!resolved) continue;
      if (!CONFIG_DIR_PATTERN.test(resolved.filePath) && !/config|settings/i.test(imported.source)) {
        continue;
      }
      const users = candidates.get(resolved.filePath) ?? [];
      if (!users.includes(file.filePath)) users.push(file.filePath);
      candidates.set(resolved.filePath, users);
    }
  }
  let best: OwnedConfigModule | null = null;
  for (const [filePath, importedBy] of candidates) {
    if (importedBy.length >= 2 && (!best || importedBy.length > best.importedBy.length)) {
      best = { filePath, importedBy: importedBy.slice(0, 8) };
    }
  }
  return best;
}

export function buildDuplicateConfigSourceEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): DuplicateConfigSourceEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  const newReads: NewConfigRead[] = [];
  let compared = 0;

  for (const change of changes) {
    const parsed = parseCached(change.filePath, change.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    compared += 1;
    const changedLines = changedLineSet(change);
    const lines = change.source.split("\n");
    lines.forEach((text, index) => {
      if (newReads.length >= 10) return;
      if (!changedLines.has(index + 1)) return;
      const kind = kindOf(text);
      if (!kind) return;
      if (change.oldSource !== null && change.oldSource.includes(text.trim()) && kind === "env-read") {
        return;
      }
      newReads.push({
        filePath: change.filePath,
        expression: text.trim().slice(0, 200),
        kind,
        line: index + 1,
      });
    });
  }

  if (newReads.length === 0) return undefined;

  const ownedModule = findOwnedModule(projectFiles);
  if (!ownedModule) return undefined;

  const readFiles = new Set(newReads.map(({ filePath }) => filePath));
  let delegatesToOwned = false;
  for (const filePath of readFiles) {
    const file = projectFiles.find((entry) => entry.filePath === filePath);
    if (!file) continue;
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    delegatesToOwned = moduleImports(parsed.program).some(({ source }) => {
      const resolved = resolveModule(file.filePath, source, projectFiles);
      return resolved?.filePath === ownedModule.filePath;
    });
    if (delegatesToOwned) break;
  }

  const ownedChannelUsers = ownedModule.importedBy.length;
  let directEnvUsers = 0;
  for (const file of projectFiles) {
    if (CONFIG_DIR_PATTERN.test(file.filePath)) continue;
    if (file.filePath === ownedModule.filePath) continue;
    if (ENV_READ_PATTERN.test(file.source)) directEnvUsers += 1;
  }

  return {
    anchorFile: candidate.filePath,
    coverage: { totalFiles: changes.length, comparedFiles: compared },
    newReads,
    ownedModule,
    delegatesToOwned,
    ownedChannelUsers,
    directEnvUsers,
  };
}
