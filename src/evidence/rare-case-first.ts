import { parseSync, Visitor } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type RareCaseBranch = {
  line: number;
  test: string;
  rareSignals: string[];
  consequentLines: number;
  elseLines: number;
  nominalInElse: boolean;
};

export type RareCaseFirstEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  branches: RareCaseBranch[];
  callers: FunctionCaller[];
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function statementLines(source: string, start: number, end: number): number {
  const text = source.slice(start, end).trim();
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

const NULLISH_PATTERN = /==?\s*null|!=\s*null|===\s*undefined|!==\s*undefined|\bnull\b|\bundefined\b/;
const EMPTY_LENGTH_PATTERN = /\.length\s*(===|==|!==|!=|<=|<)\s*0/;
const ERROR_PATTERN = /\berr(or)?\b/i;
const NEGATIVE_NAME_PATTERN = /\b(isNot\w*|not[A-Z]\w*|no[A-Z]\w*|disable[sd]?|without\w*|invalid\w*|missing\w*|empty\w*|fail\w*|denied\w*|unauthorized\w*|un\w+ed)\b/;
const NEGATION_PATTERN = /!\s*[A-Za-z_$]/;
const RARE_OUTCOME_PATTERN = /\bthrow\b|return\s+(null|undefined|false|-1)|new\s+Error|reject\s*\(/;

function rareSignals(test: string, consequent: string): string[] {
  const signals: string[] = [];
  if (NEGATION_PATTERN.test(test)) signals.push("negated-test");
  if (NULLISH_PATTERN.test(test)) signals.push("nullish-comparison");
  if (EMPTY_LENGTH_PATTERN.test(test)) signals.push("empty-length-check");
  if (ERROR_PATTERN.test(test)) signals.push("error-identifier");
  if (NEGATIVE_NAME_PATTERN.test(test)) signals.push("negative-name");
  if (RARE_OUTCOME_PATTERN.test(consequent)) signals.push("rare-outcome");
  return signals;
}

export function buildRareCaseFirstEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): RareCaseFirstEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const inScope = (node: { start: number; end: number }): boolean =>
    node.start >= candidate.start && node.end <= candidate.end
    && !nested.some((range) => range.start <= node.start && range.end >= node.end);

  const branches: RareCaseBranch[] = [];
  let controlDepth = 0;

  const enterControl = (node: { start: number; end: number }): void => {
    if (inScope(node)) controlDepth += 1;
  };
  const exitControl = (node: { start: number; end: number }): void => {
    if (inScope(node)) controlDepth -= 1;
  };

  new Visitor({
    IfStatement(node) {
      if (!inScope(node)) return;
      if (controlDepth === 0 && node.alternate) {
        const test = owner.source.slice(node.test.start, node.test.end);
        const consequent = owner.source.slice(node.consequent.start, node.consequent.end);
        const signals = rareSignals(test, consequent);
        if (signals.length > 0) {
          const consequentLines = statementLines(owner.source, node.consequent.start, node.consequent.end);
          const elseLines = statementLines(owner.source, node.alternate.start, node.alternate.end);
          if (elseLines > 0) {
            branches.push({
              line: lineAt(owner.source, node.start),
              test,
              rareSignals: signals,
              consequentLines,
              elseLines,
              nominalInElse: elseLines > consequentLines,
            });
          }
        }
      }
      enterControl(node);
    },
    "IfStatement:exit"(node) {
      exitControl(node);
    },
    ForStatement(node) {
      enterControl(node);
    },
    "ForStatement:exit"(node) {
      exitControl(node);
    },
    ForInStatement(node) {
      enterControl(node);
    },
    "ForInStatement:exit"(node) {
      exitControl(node);
    },
    ForOfStatement(node) {
      enterControl(node);
    },
    "ForOfStatement:exit"(node) {
      exitControl(node);
    },
    WhileStatement(node) {
      enterControl(node);
    },
    "WhileStatement:exit"(node) {
      exitControl(node);
    },
    DoWhileStatement(node) {
      enterControl(node);
    },
    "DoWhileStatement:exit"(node) {
      exitControl(node);
    },
    SwitchStatement(node) {
      enterControl(node);
    },
    "SwitchStatement:exit"(node) {
      exitControl(node);
    },
    TryStatement(node) {
      enterControl(node);
    },
    "TryStatement:exit"(node) {
      exitControl(node);
    },
  }).visit(parsed.program);

  if (branches.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    branches,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
