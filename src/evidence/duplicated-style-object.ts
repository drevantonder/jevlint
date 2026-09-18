import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { ObjectExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionNode } from "./repository.js";

export type StyleObjectFingerprint = {
  keys: string[];
  entries: string[];
};

export type StyleObjectMatch = {
  filePath: string;
  functionName: string | null;
  sharedEntries: string[];
  totalEntries: number;
  sourceExcerpt: string;
};

export type ThemeModule = {
  filePath: string;
  importedBy: string[];
};

export type DuplicatedStyleObjectEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  styleObjects: StyleObjectFingerprint[];
  matches: StyleObjectMatch[];
  themeModules: ThemeModule[];
};

const STYLE_KEY_PATTERN = /^(borderRadius|boxShadow|box-shadow|padding|margin|backgroundColor|background-color|color|fontSize|font-size|fontWeight|display|flexDirection|alignItems|justifyContent|gap|border|borderColor|borderWidth|width|height|maxWidth|minHeight|opacity|zIndex|cursor|textAlign|lineHeight|letterSpacing|outline|transition|transform|position|top|left|right|bottom|overflow|flex|gridTemplateColumns)$/;

const THEME_FILE_PATTERN = /theme|tokens|styles?|design/i;

function propertyKey(node: ObjectExpression["properties"][number]): string | undefined {
  if (node.type !== "Property") return undefined;
  if (node.key.type === "Identifier") return node.key.name;
  if (node.key.type === "Literal" && node.key.raw !== null && /^["']/.test(node.key.raw)) {
    return node.key.raw.slice(1, -1);
  }
  return undefined;
}

function fingerprintOf(node: ObjectExpression): StyleObjectFingerprint | undefined {
  const entries: string[] = [];
  const keys: string[] = [];
  for (const property of node.properties) {
    if (property.type !== "Property") continue;
    const key = propertyKey(property);
    if (!key || !STYLE_KEY_PATTERN.test(key)) continue;
    keys.push(key);
    const value = property.value;
    const normalized = value.type === "Literal"
      ? String(value.raw ?? value.value).slice(0, 60)
      : `<${value.type}>`;
    entries.push(`${key}=${normalized}`);
  }
  if (keys.length < 4) return undefined;
  return { keys, entries: entries.sort() };
}

function styleObjectsIn(
  program: Parameters<Visitor["visit"]>[0],
  fn: FunctionNode,
): StyleObjectFingerprint[] {
  const nested = nestedFunctionRanges(program, fn);
  const found: StyleObjectFingerprint[] = [];
  new Visitor({
    ObjectExpression(node) {
      if (node.start < fn.start || node.end > fn.end) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      const fingerprint = fingerprintOf(node);
      if (fingerprint) found.push(fingerprint);
    },
  }).visit(program);
  return found;
}

function sharedEntries(left: string[], right: string[]): string[] {
  const set = new Set(right);
  return left.filter((entry) => set.has(entry));
}

function themeModules(projectFiles: ProjectFile[]): ThemeModule[] {
  const themes = projectFiles.filter((file) => THEME_FILE_PATTERN.test(file.filePath));
  return themes.slice(0, 10).map((theme) => {
    const importedBy: string[] = [];
    for (const file of projectFiles) {
      if (file.filePath === theme.filePath) continue;
      if (importedBy.length >= 10) break;
      const parsed = parseCached(file.filePath, file.source);
      if (parsed.errors.some((error) => error.severity === "Error")) continue;
      const uses = moduleImports(parsed.program).some(({ source }) =>
        source.includes(theme.filePath.replace(/\.[cm]?[jt]sx?$/, "").split("/").pop() ?? "")
        || new RegExp(escapeRegExp(theme.filePath.split("/").pop()?.replace(/\.[cm]?[jt]sx?$/, "") ?? "^$")).test(source)
      );
      if (uses && !importedBy.includes(file.filePath)) importedBy.push(file.filePath);
    }
    return { filePath: theme.filePath, importedBy };
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildDuplicatedStyleObjectEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DuplicatedStyleObjectEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const styleObjects = styleObjectsIn(parsed.program, fn);
  if (styleObjects.length === 0) return undefined;

  const matches: StyleObjectMatch[] = [];
  for (const file of projectFiles) {
    const other = parseCached(file.filePath, file.source);
    if (other.errors.some((error) => error.severity === "Error")) continue;
    const objects: { node: ObjectExpression; holder: string | null }[] = [];
    const holders = new Map<string, string>();
    new Visitor({
      FunctionDeclaration(node) {
        if (node.id?.name) holders.set(`${node.start}:${node.end}`, node.id.name);
      },
      VariableDeclarator(node) {
        if (
          node.id.type === "Identifier"
          && (node.init?.type === "ArrowFunctionExpression" || node.init?.type === "FunctionExpression")
        ) holders.set(`${node.init.start}:${node.init.end}`, node.id.name);
      },
      ObjectExpression(node) {
        objects.push({ node, holder: null });
      },
    }).visit(other.program);
    for (const { node } of objects) {
      if (file.filePath === owner.filePath && node.start >= fn.start && node.end <= fn.end) continue;
      const fingerprint = fingerprintOf(node);
      if (!fingerprint) continue;
      for (const own of styleObjects) {
        const shared = sharedEntries(own.entries, fingerprint.entries);
        if (shared.length < 4) continue;
        let holder: string | null = null;
        for (const [range, holderName] of holders) {
          const [start, end] = range.split(":").map(Number);
          if ((start ?? 0) <= node.start && (end ?? 0) >= node.end) {
            holder = holderName ?? null;
            break;
          }
        }
        matches.push({
          filePath: file.filePath,
          functionName: holder,
          sharedEntries: shared.slice(0, 20),
          totalEntries: fingerprint.entries.length,
          sourceExcerpt: file.source.slice(node.start, node.end).slice(0, 1_000),
        });
      }
      if (matches.length >= 10) break;
    }
    if (matches.length >= 10) break;
  }

  if (matches.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    styleObjects: styleObjects.slice(0, 5),
    matches: matches.slice(0, 5),
    themeModules: themeModules(projectFiles),
  };
}
