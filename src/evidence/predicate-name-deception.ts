import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  isInsideNestedFunction,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type ReturnFact = {
  kind: string;
  booleanValued: boolean;
  excerpt: string;
};

export type PredicateNameDeceptionEvidence = {
  function: {
    name: string;
    prefix: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  returnType: string | null;
  returns: ReturnFact[];
  callers: FunctionCaller[];
};

const PREDICATE_PREFIX = /^(is|has|can|should|needs)(?=[A-Z0-9_]|$)/;

const COMPARISON_OPERATORS = new Set([
  "==",
  "===",
  "!=",
  "!==",
  "<",
  "<=",
  ">",
  ">=",
  "instanceof",
  "in",
]);

function isBooleanValued(argument: Expression | null | undefined): boolean {
  if (!argument) return false;
  if (argument.type === "Literal") return argument.value === true || argument.value === false;
  if (argument.type === "UnaryExpression") return argument.operator === "!";
  if (argument.type === "LogicalExpression") {
    return isBooleanValued(argument.left) && isBooleanValued(argument.right);
  }
  if (argument.type === "BinaryExpression") {
    return COMPARISON_OPERATORS.has(argument.operator);
  }
  return false;
}

function returnTypeText(source: string, fnStart: number, bodyStart: number): string | null {
  const header = source.slice(fnStart, bodyStart).trim().replace(/=>\s*$/, "").trim();
  const match = /\)\s*:\s*(.+?)\s*$/.exec(header);
  if (!match?.[1]) return null;
  return match[1].trim().slice(0, 200);
}

export function buildPredicateNameDeceptionEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): PredicateNameDeceptionEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  const prefix = PREDICATE_PREFIX.exec(name)?.[1];
  if (!prefix) return undefined;
  if (!fn.body) return undefined;

  const returnType = returnTypeText(owner.source, fn.start, fn.body.start);
  if (returnType && /\bis\b/.test(returnType)) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const returns: ReturnFact[] = [];
  if (fn.body.type === "BlockStatement") {
    new Visitor({
      ReturnStatement(node) {
        if (isInsideNestedFunction(node, nested)) return;
        if (node.start < candidate.start || node.end > candidate.end) return;
        returns.push({
          kind: node.argument?.type ?? "bare-return",
          booleanValued: isBooleanValued(node.argument),
          excerpt: owner.source.slice(node.start, node.end).slice(0, 200),
        });
      },
    }).visit(parsed.program);
  } else {
    const body: Expression = fn.body;
    returns.push({
      kind: fn.body.type,
      booleanValued: isBooleanValued(body),
      excerpt: owner.source.slice(fn.body.start, fn.body.end).slice(0, 200),
    });
  }

  if (!returns.some(({ booleanValued }) => !booleanValued)) return undefined;

  return {
    function: {
      name,
      prefix,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    returnType,
    returns: returns.slice(0, 10),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
