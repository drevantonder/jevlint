import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, CatchClause, Node, Program, TryStatement } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, RelatedProjectModule } from "./repository.js";

export type MisplacedBoundary = {
  line: number;
  tryBlock: string;
  inSpanCalls: string[];
  caughtKinds: string[];
  catchBody: string;
  uncoveredNeighbors: string[];
};

export type MisplacedErrorBoundaryEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  boundaries: MisplacedBoundary[];
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

function sourceLine(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function caughtKindsOf(handler: CatchClause, program: Program, source: string): string[] {
  const kinds = new Set<string>();
  new Visitor({
    BinaryExpression(node) {
      if (!containsNode(handler.body, node)) return;
      if (node.operator !== "instanceof") return;
      kinds.add(nodeSource(node.right, source).slice(0, 120));
    },
  }).visit(program);
  return [...kinds];
}

function callsDirectlyIn(
  statement: TryStatement,
  program: Program,
  source: string,
  nested: NodeRange[],
): string[] {
  const calls: string[] = [];
  new Visitor({
    CallExpression(call) {
      if (!containsNode(statement.block, call)) return;
      if (!belongsDirectlyToFunction(call, nested)) return;
      calls.push(nodeSource(call, source).slice(0, 200));
    },
  }).visit(program);
  return calls;
}

export function buildMisplacedErrorBoundaryEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): MisplacedErrorBoundaryEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const statements: TryStatement[] = [];
  new Visitor({
    TryStatement(statement) {
      if (containsNode(fn, statement) && belongsDirectlyToFunction(statement, nested)) {
        statements.push(statement);
      }
    },
  }).visit(parsed.program);
  if (statements.length === 0) return undefined;

  const neighbors: CallExpression[] = [];
  new Visitor({
    CallExpression(call) {
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested)) return;
      if (statements.some((statement) => containsNode(statement, call))) return;
      neighbors.push(call);
    },
  }).visit(parsed.program);

  const boundaries: MisplacedBoundary[] = statements.map((statement) => {
    const uncovered = neighbors
      .filter((call) => call.start > statement.end)
      .map((call) => nodeSource(call, ownerFile.source).slice(0, 200));
    return {
      line: sourceLine(ownerFile.source, statement.start),
      tryBlock: nodeSource(statement.block, ownerFile.source).slice(0, 500),
      inSpanCalls: callsDirectlyIn(statement, parsed.program, ownerFile.source, nested).slice(0, 8),
      caughtKinds: statement.handler
        ? caughtKindsOf(statement.handler, parsed.program, ownerFile.source)
        : [],
      catchBody: statement.handler
        ? nodeSource(statement.handler.body, ownerFile.source).slice(0, 500)
        : "",
      uncoveredNeighbors: uncovered.slice(0, 8),
    };
  });

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    boundaries,
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(
        candidate.filePath,
        parsed.program,
        projectFiles,
      ),
    },
  };
}
