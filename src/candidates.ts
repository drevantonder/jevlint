import { parseSync, Visitor } from "oxc-parser";
import type { Candidate, LineRange, ProjectFile, SourceFile } from "./types.js";
import { planModuleCandidates } from "./evidence/module.js";

interface Position {
  line: number;
  column: number;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function positionAt(starts: number[], offset: number): Position {
  let low = 0;
  let high = starts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = starts[middle] ?? 0;
    const next = starts[middle + 1] ?? Number.POSITIVE_INFINITY;
    if (offset < start) high = middle - 1;
    else if (offset >= next) low = middle + 1;
    else return { line: middle + 1, column: offset - start + 1 };
  }

  const finalIndex = starts.length - 1;
  return {
    line: finalIndex + 1,
    column: offset - (starts[finalIndex] ?? 0) + 1,
  };
}

function candidate(
  filePath: string,
  source: string,
  starts: number[],
  kind: Candidate["kind"],
  start: number,
  end: number,
): Candidate {
  const from = positionAt(starts, start);
  const to = positionAt(starts, end);
  return {
    id: "",
    kind,
    filePath,
    source: source.slice(start, end),
    start,
    end,
    startLine: from.line,
    startColumn: from.column,
    endLine: to.line,
    endColumn: to.column,
  };
}

export function extractCandidates(filePath: string, source: string): Candidate[] {
  const result = parseSync(filePath, source, { range: true });
  const parseErrors = result.errors.filter((error) => error.severity === "Error");
  if (parseErrors.length > 0) {
    throw new Error(`Could not parse ${filePath}: ${parseErrors[0]?.message ?? "unknown error"}`);
  }

  const starts = lineStarts(source);
  const candidates: Candidate[] = result.comments.map((comment) =>
    candidate(filePath, source, starts, "comment", comment.start, comment.end),
  );

  const addFunction = (node: { start: number; end: number }): void => {
    candidates.push(candidate(filePath, source, starts, "function", node.start, node.end));
  };
  const addAbstraction = (node: { start: number; end: number }): void => {
    candidates.push(candidate(filePath, source, starts, "abstraction", node.start, node.end));
  };

  new Visitor({
    ArrowFunctionExpression: addFunction,
    FunctionDeclaration: addFunction,
    FunctionExpression: addFunction,
    ClassDeclaration: addAbstraction,
    TSInterfaceDeclaration: addAbstraction,
    TSTypeAliasDeclaration: addAbstraction,
  }).visit(result.program);

  candidates.sort((left, right) => left.start - right.start || left.end - right.end);
  return candidates.map((item, index) => ({ ...item, id: `candidate_${index}` }));
}

export function filterCandidatesByChangedLines(
  candidates: Candidate[],
  changedLines: LineRange[],
): Candidate[] {
  return candidates.filter((item) =>
    changedLines.some((range) => item.startLine <= range.end && item.endLine >= range.start),
  );
}

export const MODULE_CANDIDATE_FILE_CAP = 50;

function moduleCandidate(filePath: string, index: number): Candidate {
  return {
    id: `module_${index}`,
    kind: "module",
    filePath,
    source: "",
    start: 0,
    end: 0,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  };
}

export function extractModuleCandidates(
  changes: SourceFile[],
  projectFiles: ProjectFile[],
): Candidate[] {
  const plan = planModuleCandidates(changes, projectFiles);
  return plan.included.map((change, index) => moduleCandidate(change.filePath, index));
}
