import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { resolveModule } from "./repository.js";

export type CycleEdge = {
  from: string;
  to: string;
  source: string;
  valueImport: boolean;
  importedSymbols: string[];
};

export type ImportCycleTangleEvidence = {
  anchorFile: string;
  cycle: string[];
  edges: CycleEdge[];
  directorySegments: string[][];
  closingEdgeIsNew: boolean;
};

const MAX_FILES = 60;
const MAX_EDGES = 8;

type Adjacency = Map<string, { to: string; source: string; valueImport: boolean; symbols: string[] }[]>;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function buildGraph(projectFiles: ProjectFile[]): Adjacency {
  const graph: Adjacency = new Map();
  for (const file of projectFiles.slice(0, MAX_FILES)) {
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const edges = new Map<string, { source: string; valueImport: boolean; symbols: string[] }>();
    for (const statement of parsed.program.body) {
      if (statement.type !== "ImportDeclaration") continue;
      const resolved = resolveModule(file.filePath, statement.source.value, projectFiles);
      if (!resolved || resolved.filePath === file.filePath) continue;
      const symbols = statement.specifiers.map((specifier) => specifier.local.name);
      const valueImport = statement.importKind !== "type";
      const existing = edges.get(resolved.filePath);
      if (existing) {
        existing.valueImport = existing.valueImport || valueImport;
        for (const symbol of symbols) {
          if (!existing.symbols.includes(symbol)) existing.symbols.push(symbol);
        }
        continue;
      }
      edges.set(resolved.filePath, {
        source: statement.source.value,
        valueImport,
        symbols,
      });
    }
    graph.set(file.filePath, [...edges].map(([to, edge]) => ({ to, ...edge })));
  }
  return graph;
}

function findCycle(graph: Adjacency, start: string): string[] | undefined {
  const stack: string[] = [start];
  const onStack = new Set([start]);
  const visited = new Set<string>();
  const dfs = (node: string): string[] | undefined => {
    visited.add(node);
    for (const edge of graph.get(node) ?? []) {
      if (edge.to === start && stack.length >= 1) return [...stack, start];
      if (onStack.has(edge.to)) continue;
      if (visited.has(edge.to)) continue;
      stack.push(edge.to);
      onStack.add(edge.to);
      const found = dfs(edge.to);
      if (found) return found;
      stack.pop();
      onStack.delete(edge.to);
    }
    return undefined;
  };
  return dfs(start);
}

function directorySegments(filePath: string): string[] {
  const parts = filePath.split("/");
  return parts.slice(0, -1);
}

export function buildImportCycleTangleEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): ImportCycleTangleEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  const changedPaths = new Set(changes.map(({ filePath }) => filePath));
  if (!changedPaths.has(candidate.filePath)) return undefined;
  const graph = buildGraph(projectFiles);

  for (const changed of changes) {
    if (changed.filePath !== candidate.filePath) continue;
    const cycle = findCycle(graph, changed.filePath);
    if (!cycle || cycle.length < 3) continue;

    const edges: CycleEdge[] = [];
    for (let index = 0; index < cycle.length - 1; index += 1) {
      if (edges.length >= MAX_EDGES) break;
      const from = cycle[index]!;
      const to = cycle[index + 1]!;
      const edge = graph.get(from)?.find((entry) => entry.to === to);
      if (!edge) return undefined;
      edges.push({
        from,
        to,
        source: edge.source,
        valueImport: edge.valueImport,
        importedSymbols: edge.symbols.slice(0, 10),
      });
    }

    let closingEdgeIsNew = false;
    const closing = edges.find(({ from }) => from === changed.filePath);
    if (closing && changed.oldSource !== null) {
      const parsed = parseCached(changed.filePath, changed.source);
      if (!parsed.errors.some((error) => error.severity === "Error")) {
        const changedLines = new Set<number>();
        for (const range of changed.changedLines) {
          for (let line = range.start; line <= range.end; line += 1) changedLines.add(line);
        }
        for (const statement of parsed.program.body) {
          if (statement.type !== "ImportDeclaration") continue;
          if (statement.source.value !== closing.source) continue;
          if (changedLines.has(lineAt(changed.source, statement.start))) {
            closingEdgeIsNew = true;
          }
        }
      }
    }

    return {
      anchorFile: changed.filePath,
      cycle: cycle.slice(0, MAX_EDGES + 1),
      edges,
      directorySegments: cycle.slice(0, -1).map(directorySegments).slice(0, MAX_EDGES),
      closingEdgeIsNew,
    };
  }
  return undefined;
}
