import { posix } from "node:path";
import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import { isTestFile } from "./module.js";
import { isTestFileContent } from "./test-signals.js";
import {
  findDirectFunction,
  functionName,
  isFunctionExported,
  manifestDependencies,
  moduleImports,
  resolveModule,
} from "./repository.js";

const MAX_LEAKS = 8;

const BUILD_SCRIPT_PATTERN = /(^|\/)(scripts|tools|build|config|bin)(\/|$)/;

export type DevDependencyLeak = {
  specifier: string;
  package: string | null;
  targetModule: string | null;
  via: "dev-dependency" | "test-module";
  typeOnlyImport: boolean;
  valueUses: number;
};

export type DevDependencyRuntimeLeakEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  owner: {
    buildScriptAdjacent: boolean;
  };
  manifest: string | null;
  leaks: DevDependencyLeak[];
};

function packageRoot(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/")) return null;
  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    if (!scope || !name) return null;
    return `${scope}/${name}`;
  }
  const [name] = specifier.split("/");
  return name ?? null;
}

function manifestFor(ownerPath: string, projectFiles: ProjectFile[]): ProjectFile | undefined {
  const manifests = projectFiles.filter(({ filePath }) => posix.basename(filePath) === "package.json");
  if (manifests.length === 0) return undefined;
  const ownerDir = posix.dirname(posix.normalize(ownerPath));
  const sharedPrefix = (left: string): number => {
    const manifestDir = posix.dirname(posix.normalize(left));
    const ownerSegments = ownerDir.split("/");
    const manifestSegments = manifestDir.split("/");
    let shared = 0;
    while (
      shared < ownerSegments.length
      && shared < manifestSegments.length
      && ownerSegments[shared] === manifestSegments[shared]
    ) shared += 1;
    return shared;
  };
  return [...manifests].sort((left, right) =>
    sharedPrefix(right.filePath) - sharedPrefix(left.filePath)
    || left.filePath.length - right.filePath.length
  )[0];
}

function importStatementRanges(
  filePath: string,
  source: string,
): { source: string; start: number; end: number; typeOnly: boolean }[] {
  const parsed = parseCached(filePath, source);
  if (parsed.errors.some((error) => error.severity === "Error")) return [];
  const ranges: { source: string; start: number; end: number; typeOnly: boolean }[] = [];
  for (const statement of parsed.program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const text = source.slice(statement.start, statement.end);
    ranges.push({
      source: statement.source.value,
      start: statement.start,
      end: statement.end,
      typeOnly: /^\s*import\s+type\b/.test(text),
    });
  }
  return ranges;
}

function valueUsesOf(
  filePath: string,
  source: string,
  local: string,
  importRanges: { start: number; end: number }[],
): number {
  const parsed = parseCached(filePath, source);
  if (parsed.errors.some((error) => error.severity === "Error")) return 0;
  let uses = 0;
  new Visitor({
    Identifier(node) {
      if (node.name !== local) return;
      if (importRanges.some(({ start, end }) => start <= node.start && node.end <= end)) return;
      uses += 1;
    },
  }).visit(parsed.program);
  return uses;
}

export function buildDevDependencyRuntimeLeakEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DevDependencyRuntimeLeakEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  // Filename-only: the suspected dev-dependency import itself must not
  // exonerate the owner, or a shipped file importing a runner would always
  // classify as a test and the leak could never fire. Test targets still
  // classify through the full content signals below.
  if (isTestFile(candidate.filePath)) return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const manifest = manifestFor(owner.filePath, projectFiles);
  const dependencies = manifest ? manifestDependencies(manifest.source) : [];
  const runtimeSections = new Set(
    dependencies.filter(({ section }) => section !== "devDependencies").map(({ name: dep }) => dep),
  );
  const devOnly = new Set(
    dependencies
      .filter(({ section }) => section === "devDependencies")
      .map(({ name: dep }) => dep)
      .filter((dep) => !runtimeSections.has(dep)),
  );

  const statements = importStatementRanges(owner.filePath, owner.source);
  const imports = moduleImports(parsed.program);
  const leaks: DevDependencyLeak[] = [];
  const seen = new Set<string>();
  for (const imported of imports) {
    if (leaks.length >= MAX_LEAKS) break;
    const key = `${imported.source}::${imported.local}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const statement = statements.find(({ source }) => source === imported.source);
    const uses = valueUsesOf(owner.filePath, owner.source, imported.local, statements);
    const root = packageRoot(imported.source);
    if (root && devOnly.has(root)) {
      leaks.push({
        specifier: imported.source,
        package: root,
        targetModule: null,
        via: "dev-dependency",
        typeOnlyImport: statement?.typeOnly ?? false,
        valueUses: uses,
      });
      continue;
    }
    if (!imported.source.startsWith(".")) continue;
    const target = resolveModule(owner.filePath, imported.source, projectFiles);
    if (!target) continue;
    if (!isTestFileContent(target.filePath, target.source)) continue;
    leaks.push({
      specifier: imported.source,
      package: null,
      targetModule: target.filePath,
      via: "test-module",
      typeOnlyImport: statement?.typeOnly ?? false,
      valueUses: uses,
    });
  }
  if (leaks.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    owner: {
      buildScriptAdjacent: BUILD_SCRIPT_PATTERN.test(candidate.filePath),
    },
    manifest: manifest?.filePath ?? null,
    leaks,
  };
}
