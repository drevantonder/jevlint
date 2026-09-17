import { parseSync, Visitor } from "oxc-parser";
import type { Expression, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

type OperationEvidence = {
  action: string;
  expression: string;
  awaited: boolean;
};

type LocatedOperation = OperationEvidence & {
  start: number;
  end: number;
};

type TransactionSignal = {
  kind: "call" | "parameter";
  expression: string;
};

type TryStatementEvidence = {
  source: string;
  hasCatch: boolean;
  hasFinally: boolean;
};

type AtomicityStructure = {
  operations: LocatedOperation[];
  transactionSignals: TransactionSignal[];
  tryStatements: TryStatementEvidence[];
};

export type ImplicitAtomicityEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  operations: OperationEvidence[];
  transactionSignals: TransactionSignal[];
  errorHandling: {
    tryStatements: TryStatementEvidence[];
    compensatingOperations: OperationEvidence[];
  };
  callers: FunctionCaller[];
};

const OPERATION_NAME = /^(?:add|append|charge|clear|commit|create|credit|debit|delete|deposit|dispatch|emit|enqueue|insert|invalidate|mark|notify|persist|publish|put|record|register|release|remove|reserve|save|send|set|store|track|update|withdraw|write)(?:[A-Z_]|$)/;
const COMPENSATION_NAME = /^(?:cancel|compensate|credit|refund|release|restore|revert|rollback|void)(?:[A-Z_]|$)/;
const TRANSACTION_NAME = /^(?:atomic|runInTransaction|transaction|unitOfWork|withTransaction|withUnitOfWork)$/i;
const TRANSACTION_PARAMETER = /\b(?:session|transaction|tx|unitOfWork)\b/i;

function calledName(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "ChainExpression") return calledName(expression.expression);
  if (
    expression.type === "MemberExpression"
    && !expression.computed
    && expression.property.type === "Identifier"
  ) return expression.property.name;
  return undefined;
}

function structuralEvidence(
  source: string,
  program: Program,
  fn: FunctionNode,
): AtomicityStructure {
  const awaits: Array<{ start: number; end: number }> = [];
  const tryStatements: TryStatementEvidence[] = [];
  new Visitor({
    AwaitExpression(node) {
      if (node.start >= fn.start && node.end <= fn.end) {
        awaits.push({ start: node.argument.start, end: node.argument.end });
      }
    },
    TryStatement(node) {
      if (node.start < fn.start || node.end > fn.end) return;
      tryStatements.push({
        source: source.slice(node.start, node.end),
        hasCatch: node.handler !== null,
        hasFinally: node.finalizer !== null,
      });
    },
  }).visit(program);

  const operations: LocatedOperation[] = [];
  const transactionSignals: TransactionSignal[] = [];
  new Visitor({
    CallExpression(node) {
      if (node.start < fn.start || node.end > fn.end) return;
      const action = calledName(node.callee);
      if (!action) return;
      const expression = source.slice(node.start, node.end);
      if (TRANSACTION_NAME.test(action)) {
        transactionSignals.push({ kind: "call", expression });
      }
      if (!OPERATION_NAME.test(action)) return;
      operations.push({
        action,
        expression,
        awaited: awaits.some((awaited) => awaited.start <= node.start && awaited.end >= node.end),
        start: node.start,
        end: node.end,
      });
    },
  }).visit(program);

  for (const parameter of fn.params) {
    const expression = source.slice(parameter.start, parameter.end);
    if (TRANSACTION_PARAMETER.test(expression)) {
      transactionSignals.push({ kind: "parameter", expression });
    }
  }
  return { operations, transactionSignals, tryStatements };
}

export function buildImplicitAtomicityEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ImplicitAtomicityEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const { operations, transactionSignals, tryStatements } = structuralEvidence(
    owner.source,
    parsed.program,
    fn,
  );
  if (operations.length < 2) return undefined;
  const visibleOperations = operations.map(({ action, expression, awaited }) => ({
    action,
    expression,
    awaited,
  }));
  const compensatingOperations = operations
    .filter(({ action }) => COMPENSATION_NAME.test(action))
    .map(({ action, expression, awaited }) => ({ action, expression, awaited }));

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    operations: visibleOperations,
    transactionSignals,
    errorHandling: { tryStatements, compensatingOperations },
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
