import { posix } from "node:path";
import { parseCached } from "./parse-cache.js";
import { isTestFilename, isTestProjectFile } from "./test-signals.js";
import type { Program } from "oxc-parser";
import type { ProjectFile, SourceFile } from "../types.js";
import { resolveModule } from "./repository.js";

export const MODULE_SIBLING_CAP = 40;
export const MODULE_IN_EDGE_CAP = 40;
export const MODULE_BARREL_REEXPORT_CAP = 20;
export const MODULE_CANDIDATE_FILE_CAP = 50;

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);

export type SiblingFact = {
  path: string;
  kind: "source" | "test" | "barrel" | "config" | "asset";
}

export type ImportEdge = {
  from: string;
  to: string;
  resolved: string | null;
  depthDelta: number;
  crossesTopDir: boolean;
}

export type LayerRole =
  | "domain"
  | "application"
  | "adapter"
  | "transport"
  | "shared"
  | "test"
  | "config"
  | "unknown";

export type LayerFact = {
  dir: string;
  inferredRole: LayerRole;
  basis: "segment" | "import-graph" | "both";
}

export type BarrelReExportFact = {
  target: string;
  symbols: string[];
}

export type ModuleEvidence = {
  dir: string;
  depth: number;
  siblings: SiblingFact[];
  siblingSuffixProfile: Record<string, number>;
  depthDistribution: { depth: number; count: number }[];
  barrel: {
    inDir: boolean;
    path: string | null;
    reExportsSelf: boolean;
    reExports: BarrelReExportFact[];
    reExportsTruncated: boolean;
  };
  layer: LayerFact;
  importEdgesOut: ImportEdge[];
  importEdgesIn: ImportEdge[];
  repoNorms: {
    testPlacement: {
      value: "colocated" | "mixed" | "unknown";
      testFiles: number;
      colocated: number;
      agreement: number;
    };
    featureGrouping: {
      value: "by-feature" | "by-layer" | "mixed" | "unknown";
      topDirs: { dir: string; files: number }[];
      layerLikeFiles: number;
      sourceFiles: number;
    };
    barrelDiscipline: {
      value: "barrel-per-feature" | "root-only" | "none" | "mixed" | "unknown";
      sourceDirs: number;
      dirsWithBarrel: number;
      rootBarrel: boolean;
    };
  };
  changeFacts: {
    added: boolean;
    renamedFrom: string | null;
    linesAdded: number;
  };
  coverage: {
    evaluatedFiles: number;
    omittedFiles: number;
  };
  truncated: boolean;
}

export function dirOf(filePath: string): string {
  const normalized = posix.normalize(filePath);
  const dir = posix.dirname(normalized);
  return dir === "." ? "" : dir;
}

export function depthOfDir(dir: string): number {
  if (dir === "") return 0;
  return dir.split("/").length;
}

export function topDirOf(filePath: string): string {
  const normalized = posix.normalize(filePath);
  const segment = normalized.split("/")[0] ?? "";
  return normalized.includes("/") ? segment : "";
}

export function isSourcePath(filePath: string): boolean {
  const basename = posix.basename(filePath);
  const dot = basename.lastIndexOf(".");
  const extension = dot >= 0 ? basename.slice(dot).toLowerCase() : "";
  if (SOURCE_EXTENSIONS.has(extension)) return true;
  if (/(^|\.)d\.([cm]?ts)$/.test(basename)) return true;
  return false;
}

export function isTestFile(filePath: string, projectFiles?: ProjectFile[]): boolean {
  if (projectFiles !== undefined) return isTestProjectFile(filePath, projectFiles);
  return isTestFilename(filePath);
}

const BARREL_BASENAME_PATTERN = /^index\.[cm]?[jt]sx?$/;

export function isBarrelFile(filePath: string): boolean {
  return BARREL_BASENAME_PATTERN.test(posix.basename(filePath));
}

const CONFIG_BASENAME_PATTERN =
  /^(.*\.config|.*\.conf|.*rc|\.env.*|Dockerfile|.*\.toml|.*\.ya?ml|.*\.json|.*\.ini)$/i;

export function siblingKind(filePath: string, projectFiles?: ProjectFile[]): SiblingFact["kind"] {
  if (isBarrelFile(filePath)) return "barrel";
  if (isTestFile(filePath, projectFiles)) return "test";
  if (!isSourcePath(filePath)) return "asset";
  if (CONFIG_BASENAME_PATTERN.test(posix.basename(filePath))) return "config";
  return "source";
}

const SCAFFOLDED_SEGMENT_PATTERN = /(^|\/)app(\/|$)|\([^/]*\)|__generated__|\.expo(\/|$)|(^|\/)generated(\/|$)/;

export function isFrameworkScaffolded(filePath: string): boolean {
  return SCAFFOLDED_SEGMENT_PATTERN.test(posix.normalize(filePath));
}

export function testStem(filePath: string): string | null {
  const basename = posix.basename(filePath);
  const match = /^(.*)\.(test|spec)\.[cm]?[jt]sx?$/.exec(basename);
  return match ? (match[1] ?? null) : null;
}

export function plainStem(filePath: string): string {
  const basename = posix.basename(filePath);
  const dot = basename.indexOf(".");
  return dot > 0 ? basename.slice(0, dot) : basename;
}

export function fileSuffixProfile(basename: string): string {
  const dot = basename.indexOf(".");
  if (dot <= 0) return "plain";
  return basename.slice(dot);
}

const LAYER_SEGMENTS: { role: LayerRole; segments: Set<string> }[] = [
  { role: "domain", segments: new Set(["domain", "core", "entities", "entity", "model", "models"]) },
  {
    role: "application",
    segments: new Set(["application", "use-cases", "usecases", "use_cases", "services", "service"]),
  },
  {
    role: "adapter",
    segments: new Set([
      "infrastructure",
      "adapters",
      "adapter",
      "persistence",
      "repositories",
      "repository",
      "db",
      "prisma",
      "drizzle",
    ]),
  },
  {
    role: "transport",
    segments: new Set([
      "presentation",
      "ui",
      "routes",
      "route",
      "controllers",
      "controller",
      "api",
      "http",
      "pages",
      "app",
      "views",
      "components",
    ]),
  },
  {
    role: "shared",
    segments: new Set(["shared", "common", "utils", "helpers", "helper", "util", "lib", "kit"]),
  },
  {
    role: "test",
    segments: new Set(["__tests__", "tests", "test", "e2e", "spec", "__fixtures__", "fixtures", "mocks", "__mocks__"]),
  },
  { role: "config", segments: new Set(["config", "configs", "conf"]) },
];

export function inferLayer(dir: string): LayerFact {
  const segments = dir === "" ? [] : dir.split("/");
  for (const segment of segments) {
    const lowered = segment.toLowerCase();
    for (const { role, segments: names } of LAYER_SEGMENTS) {
      if (names.has(lowered)) return { dir, inferredRole: role, basis: "segment" };
    }
  }
  return { dir, inferredRole: "unknown", basis: "segment" };
}

export function parseProgram(filePath: string, source: string): Program | undefined {
  const parsed = parseCached(filePath, source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  return parsed.program;
}

export function moduleImportSpecifiers(program: Program): string[] {
  const result = new Set<string>();
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {
      result.add(statement.source.value);
      continue;
    }
    if (
      (statement.type === "ExportAllDeclaration" || statement.type === "ExportNamedDeclaration")
      && statement.source
    ) {
      result.add(statement.source.value);
    }
  }
  return [...result];
}

function declarationName(kind: string, name: string | undefined): string | null {
  if (kind === "default") return "default";
  if (name) return name;
  return null;
}

function exportedSymbolName(specifier: { exported: { type: string; name?: string; value?: string } }): string {
  const exported = specifier.exported;
  if (exported.type === "Identifier" && exported.name) return exported.name;
  if (exported.value) return exported.value;
  return "unknown";
}

export function moduleExportNames(program: Program): string[] {
  const names: string[] = [];
  const push = (name: string | null): void => {
    if (name && !names.includes(name)) names.push(name);
  };
  for (const statement of program.body) {
    if (statement.type === "ExportAllDeclaration") {
      push("*");
      continue;
    }
    if (statement.type === "ExportDefaultDeclaration") {
      push(declarationName("default", undefined));
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration") continue;
    if (statement.declaration) {
      const declaration = statement.declaration;
      if (
        (declaration.type === "FunctionDeclaration"
          || declaration.type === "ClassDeclaration"
          || declaration.type === "TSInterfaceDeclaration"
          || declaration.type === "TSTypeAliasDeclaration")
        && declaration.id
      ) {
        push(declaration.id.name);
      } else if (declaration.type === "VariableDeclaration") {
        for (const declarator of declaration.declarations) {
          if (declarator.id.type === "Identifier") push(declarator.id.name);
        }
      }
      continue;
    }
    for (const specifier of statement.specifiers) {
      push(exportedSymbolName(specifier));
    }
  }
  return names;
}

export function barrelReExports(barrel: ProjectFile): BarrelReExportFact[] {
  const program = parseProgram(barrel.filePath, barrel.source);
  if (!program) return [];
  const facts: BarrelReExportFact[] = [];
  for (const statement of program.body) {
    if (facts.length >= MODULE_BARREL_REEXPORT_CAP) break;
    if (statement.type === "ExportAllDeclaration") {
      facts.push({ target: statement.source.value, symbols: ["*"] });
      continue;
    }
    if (statement.type === "ExportNamedDeclaration" && statement.source) {
      const symbols = statement.specifiers.map(exportedSymbolName);
      facts.push({ target: statement.source.value, symbols });
    }
  }
  return facts;
}

export function barrelReExportCount(barrel: ProjectFile): number {
  const program = parseProgram(barrel.filePath, barrel.source);
  if (!program) return 0;
  let count = 0;
  for (const statement of program.body) {
    if (statement.type === "ExportAllDeclaration") count += 1;
    else if (statement.type === "ExportNamedDeclaration" && statement.source) count += 1;
  }
  return count;
}

export type ModuleGraph = {
  specifiers: Map<string, string[]>;
  exports: Map<string, string[] | undefined>;
}

export function buildModuleGraphUncached(projectFiles: ProjectFile[]): ModuleGraph {
  const specifiers = new Map<string, string[]>();
  const exports = new Map<string, string[] | undefined>();
  for (const file of projectFiles) {
    if (!isSourcePath(file.filePath)) continue;
    const program = parseProgram(file.filePath, file.source);
    if (!program) {
      specifiers.set(file.filePath, []);
      exports.set(file.filePath, undefined);
      continue;
    }
    specifiers.set(file.filePath, moduleImportSpecifiers(program));
    exports.set(file.filePath, moduleExportNames(program));
  }
  return { specifiers, exports };
}

// Single-entry shared graph: audit and review runs pass the same
// projectFiles array (and the same source string objects) to every
// rule-candidate pair, so identity comparison is O(files) pointer checks
// with zero content hashing. Any new array, reordered array, or replaced
// source string misses and rebuilds. Callers must not mutate the returned
// graph (no current caller does; gates verify this).
const graphCache = new WeakMap<
  ProjectFile[],
  { refs: ProjectFile[]; sources: string[]; graph: ModuleGraph }
>();

export function buildModuleGraph(projectFiles: ProjectFile[]): ModuleGraph {
  if (process.env["JEVLINT_PARSE_CACHE"] === "0") {
    return buildModuleGraphUncached(projectFiles);
  }
  const cached = graphCache.get(projectFiles);
  if (
    cached !== undefined
    && cached.refs.length === projectFiles.length
    && projectFiles.every((file, index) =>
      file === cached.refs[index] && file.source === cached.sources[index]
    )
  ) return cached.graph;
  const graph = buildModuleGraphUncached(projectFiles);
  graphCache.set(projectFiles, {
    refs: [...projectFiles],
    sources: projectFiles.map((file) => file.source),
    graph,
  });
  return graph;
}

function makeEdge(from: string, to: string, resolved: string | null): ImportEdge {
  const fromDir = dirOf(from);
  const toDir = resolved ? dirOf(resolved) : dirOf(posix.normalize(posix.join(fromDir, to)));
  return {
    from,
    to,
    resolved,
    depthDelta: depthOfDir(toDir) - depthOfDir(fromDir),
    crossesTopDir: topDirOf(from) !== (resolved ? topDirOf(resolved) : ""),
  };
}

export function edgesOut(
  filePath: string,
  graph: ModuleGraph,
  projectFiles: ProjectFile[],
): ImportEdge[] {
  const specifiers = graph.specifiers.get(filePath) ?? [];
  return specifiers.map((specifier) => {
    const resolved = resolveModule(filePath, specifier, projectFiles);
    return makeEdge(filePath, specifier, resolved?.filePath ?? null);
  });
}

export function edgesIn(
  filePath: string,
  graph: ModuleGraph,
  projectFiles: ProjectFile[],
) {
  const edges: ImportEdge[] = [];
  for (const [from, specifiers] of graph.specifiers) {
    if (from === filePath) continue;
    for (const specifier of specifiers) {
      const resolved = resolveModule(from, specifier, projectFiles);
      if (resolved?.filePath !== filePath) continue;
      edges.push(makeEdge(from, specifier, filePath));
      if (edges.length >= MODULE_IN_EDGE_CAP) {
        return { edges, truncated: true };
      }
    }
  }
  edges.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
  return { edges, truncated: false };
}

function sourceFiles(projectFiles: ProjectFile[]): ProjectFile[] {
  return projectFiles.filter((file) => isSourcePath(file.filePath));
}

function testPlacementNorm(projectFiles: ProjectFile[]): ModuleEvidence["repoNorms"]["testPlacement"] {
  const tests = sourceFiles(projectFiles).filter((file) => isTestFile(file.filePath, projectFiles));
  if (tests.length === 0) {
    return { value: "unknown", testFiles: 0, colocated: 0, agreement: 0 };
  }
  const byDir = new Map<string, Set<string>>();
  for (const file of sourceFiles(projectFiles)) {
    const dir = dirOf(file.filePath);
    let set = byDir.get(dir);
    if (!set) {
      set = new Set();
      byDir.set(dir, set);
    }
    set.add(posix.basename(file.filePath));
  }
  let colocated = 0;
  for (const test of tests) {
    const stem = testStem(test.filePath);
    const siblings = byDir.get(dirOf(test.filePath)) ?? new Set();
    const hasSubject = stem !== null
      && [...siblings].some((name) => plainStem(name) === stem && name !== posix.basename(test.filePath));
    if (hasSubject) colocated += 1;
  }
  const agreement = colocated / tests.length;
  // Directory placement used to be a separate norm value keyed on test-dir
  // names. With directory gates removed, placement is colocated or mixed.
  const value = agreement >= 0.7 ? "colocated" : "mixed";
  return { value, testFiles: tests.length, colocated, agreement };
}

const LAYER_LIKE_TOP_DIRS = new Set([
  "services",
  "service",
  "controllers",
  "controller",
  "models",
  "model",
  "entities",
  "utils",
  "helpers",
  "helper",
  "lib",
  "shared",
  "common",
  "routes",
  "route",
  "api",
  "components",
  "hooks",
  "domain",
  "application",
  "infrastructure",
  "adapters",
  "presentation",
  "ui",
  "db",
  "config",
]);

function featureGroupingNorm(
  projectFiles: ProjectFile[],
): ModuleEvidence["repoNorms"]["featureGrouping"] {
  const sources = sourceFiles(projectFiles);
  const counts = new Map<string, number>();
  for (const file of sources) {
    const top = topDirOf(file.filePath);
    if (top === "") continue;
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  const topDirs = [...counts.entries()]
    .map(([dir, files]) => ({ dir, files }))
    .sort((left, right) => right.files - left.files || left.dir.localeCompare(right.dir));
  let layerLikeFiles = 0;
  for (const { dir, files } of topDirs) {
    if (LAYER_LIKE_TOP_DIRS.has(dir.toLowerCase())) layerLikeFiles += files;
  }
  const sourceFilesCount = sources.length;
  const value = sourceFilesCount === 0
    ? "unknown"
    : layerLikeFiles / sourceFilesCount >= 0.7
    ? "by-layer"
    : topDirs.filter(({ files }) => files >= 3).length >= 3
    ? "by-feature"
    : "mixed";
  return { value, topDirs: topDirs.slice(0, 20), layerLikeFiles, sourceFiles: sourceFilesCount };
}

function barrelDisciplineNorm(
  projectFiles: ProjectFile[],
): ModuleEvidence["repoNorms"]["barrelDiscipline"] {
  const sources = sourceFiles(projectFiles);
  if (sources.length === 0) {
    return { value: "unknown", sourceDirs: 0, dirsWithBarrel: 0, rootBarrel: false };
  }
  const dirs = new Set<string>();
  const withBarrel = new Set<string>();
  let rootBarrel = false;
  for (const file of sources) {
    const dir = dirOf(file.filePath);
    if (dir !== "") dirs.add(dir);
    if (isBarrelFile(file.filePath)) {
      if (dir === "") rootBarrel = true;
      else withBarrel.add(dir);
    }
  }
  const sourceDirs = dirs.size;
  const dirsWithBarrel = withBarrel.size;
  const value = sourceDirs === 0
    ? rootBarrel ? "root-only" : "none"
    : dirsWithBarrel / sourceDirs >= 0.7
    ? "barrel-per-feature"
    : dirsWithBarrel === 0
    ? rootBarrel ? "root-only" : "none"
    : "mixed";
  return { value, sourceDirs, dirsWithBarrel, rootBarrel };
}

export type ModuleCandidatePlan = {
  included: SourceFile[];
  omitted: number;
}

function specifierSet(source: string | null, filePath: string): Set<string> | undefined {
  if (source === null) return new Set();
  const program = parseProgram(filePath, source);
  if (!program) return undefined;
  return new Set(moduleImportSpecifiers(program));
}

function exportSet(source: string | null, filePath: string): Set<string> | undefined {
  if (source === null) return new Set();
  const program = parseProgram(filePath, source);
  if (!program) return undefined;
  return new Set(moduleExportNames(program));
}

function symmetricDiffSize(left: Set<string>, right: Set<string>): number {
  let size = 0;
  for (const item of left) if (!right.has(item)) size += 1;
  for (const item of right) if (!left.has(item)) size += 1;
  return size;
}

export function planModuleCandidates(
  changes: SourceFile[],
  _projectFiles: ProjectFile[],
): ModuleCandidatePlan {
  const scored: { change: SourceFile; edgeChanges: number; exportChanges: number }[] = [];
  for (const change of changes) {
    if (!isSourcePath(change.filePath)) continue;
    if (change.oldSource === null) {
      const current = specifierSet(change.source, change.filePath);
      scored.push({
        change,
        edgeChanges: current ? current.size : 0,
        exportChanges: exportSet(change.source, change.filePath)?.size ?? 0,
      });
      continue;
    }
    const beforeImports = specifierSet(change.oldSource, change.filePath);
    const afterImports = specifierSet(change.source, change.filePath);
    if (beforeImports === undefined || afterImports === undefined) continue;
    const edgeChanges = symmetricDiffSize(beforeImports, afterImports);
    const beforeExports = exportSet(change.oldSource, change.filePath);
    const afterExports = exportSet(change.source, change.filePath);
    const exportChanges = beforeExports !== undefined && afterExports !== undefined
      ? symmetricDiffSize(beforeExports, afterExports)
      : 0;
    if (edgeChanges === 0 && exportChanges === 0) continue;
    scored.push({ change, edgeChanges, exportChanges });
  }
  scored.sort((left, right) =>
    right.edgeChanges - left.edgeChanges
    || right.exportChanges - left.exportChanges
    || left.change.filePath.localeCompare(right.change.filePath)
  );
  return {
    included: scored.slice(0, MODULE_CANDIDATE_FILE_CAP).map(({ change }) => change),
    omitted: Math.max(0, scored.length - MODULE_CANDIDATE_FILE_CAP),
  };
}

export function buildModuleEvidence(
  filePath: string,
  changes: SourceFile[],
  projectFiles: ProjectFile[],
  graph?: ModuleGraph,
): ModuleEvidence | undefined {
  const sources = sourceFiles(projectFiles);
  if (sources.length < 10) return undefined;
  const dir = dirOf(filePath);
  const change = changes.find((item) => item.filePath === filePath);
  const added = change ? change.oldSource === null : true;
  const hasSibling = sources.some((file) => file.filePath !== filePath && dirOf(file.filePath) === dir);
  if (added && !hasSibling) return undefined;

  const resolvedGraph = graph ?? buildModuleGraph(projectFiles);
  const dirFiles = sources.filter((file) => dirOf(file.filePath) === dir && file.filePath !== filePath);
  const siblingsTruncated = dirFiles.length > MODULE_SIBLING_CAP;
  const siblings: SiblingFact[] = dirFiles
    .slice(0, MODULE_SIBLING_CAP)
    .map((file) => ({ path: file.filePath, kind: siblingKind(file.filePath, projectFiles) }))
    .sort((left, right) => left.path.localeCompare(right.path));

  const siblingSuffixProfile: Record<string, number> = {};
  for (const file of dirFiles) {
    const suffix = fileSuffixProfile(posix.basename(file.filePath));
    siblingSuffixProfile[suffix] = (siblingSuffixProfile[suffix] ?? 0) + 1;
  }

  const depthCounts = new Map<number, number>();
  for (const file of sources) {
    const depth = depthOfDir(dirOf(file.filePath));
    depthCounts.set(depth, (depthCounts.get(depth) ?? 0) + 1);
  }
  const depthDistribution = [...depthCounts.entries()]
    .map(([depth, count]) => ({ depth, count }))
    .sort((left, right) => left.depth - right.depth);

  const barrelExtensions = ["index.ts", "index.tsx", "index.mts", "index.cts", "index.js", "index.jsx", "index.mjs", "index.cjs"];
  const barrelPath = barrelExtensions
    .map((name) => (dir === "" ? name : `${dir}/${name}`))
    .find((path) => sources.some((file) => file.filePath === path)) ?? null;
  const barrelFile = barrelPath ? sources.find((file) => file.filePath === barrelPath) : undefined;
  let reExports: BarrelReExportFact[] = [];
  let reExportsTruncated = false;
  let reExportsSelf = false;
  if (barrelFile) {
    reExports = barrelReExports(barrelFile);
    reExportsTruncated = barrelReExportCount(barrelFile) > reExports.length;
    reExportsSelf = reExports.some(({ target }) =>
      resolveModule(barrelFile.filePath, target, projectFiles)?.filePath === filePath
    );
  }

  const incoming = edgesIn(filePath, resolvedGraph, projectFiles);
  const linesAdded = change
    ? change.changedLines.reduce((total, range) => total + Math.max(0, range.end - range.start + 1), 0)
    : 0;
  const plan = planModuleCandidates(changes, projectFiles);
  const truncated = siblingsTruncated || incoming.truncated || reExportsTruncated;

  return {
    dir,
    depth: depthOfDir(dir),
    siblings,
    siblingSuffixProfile,
    depthDistribution,
    barrel: {
      inDir: barrelPath !== null,
      path: barrelPath,
      reExportsSelf,
      reExports,
      reExportsTruncated,
    },
    layer: inferLayer(dir),
    importEdgesOut: edgesOut(filePath, resolvedGraph, projectFiles),
    importEdgesIn: incoming.edges,
    repoNorms: {
      testPlacement: testPlacementNorm(projectFiles),
      featureGrouping: featureGroupingNorm(projectFiles),
      barrelDiscipline: barrelDisciplineNorm(projectFiles),
    },
    changeFacts: { added, renamedFrom: null, linesAdded },
    coverage: { evaluatedFiles: plan.included.length, omittedFiles: plan.omitted },
    truncated,
  };
}
