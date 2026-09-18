import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type ComparatorKind = "none" | "subtract" | "relational" | "locale-aware" | "other";

export type BlindSort = {
  call: string;
  line: number;
  value: string;
  valueSource: "parameter" | "member" | "local" | "unknown";
  comparatorKind: ComparatorKind;
  localeAware: boolean;
};

export type BlindComparison = {
  expression: string;
  line: number;
  inSortComparator: boolean;
};

export type LocaleBlindOrderingEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  sorts: BlindSort[];
  comparisons: BlindComparison[];
  mitigations: {
    collatorInFunction: boolean;
    collatorInModule: boolean;
  };
  callers: FunctionCaller[];
};

const ORDER_OPERATORS = new Set(["<", ">", "<=", ">="]);
const LOCALE_SIGNAL_PATTERN = /Intl\.Collator|localeCompare/;
const RELATIONAL_PATTERN = /<|>/;
const SUBTRACT_PATTERN = /-/;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function parameterNamesOf(params: { start: number; end: number }[], source: string): Set<string> {
  const names = new Set<string>();
  for (const parameter of params) {
    const match = /^(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(source.slice(parameter.start, parameter.end).trim());
    if (match?.[1]) names.add(match[1]);
  }
  return names;
}

function rootName(text: string): string | undefined {
  const match = /^([A-Za-z_$][\w$]*)/.exec(text.trim());
  return match?.[1];
}

export function buildLocaleBlindOrderingEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): LocaleBlindOrderingEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const direct = (node: { start: number; end: number }): boolean =>
    node.start >= candidate.start && node.end <= candidate.end
    && belongsDirectlyToFunction(node, nested);

  const parameters = parameterNamesOf(fn.params, owner.source);
  const comparatorRanges: { start: number; end: number }[] = [];
  const collatorNames = new Set<string>();
  const sorts: BlindSort[] = [];

  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || !node.init) return;
      if (/new\s+Intl\.Collator/.test(owner.source.slice(node.init.start, node.init.end))) {
        collatorNames.add(node.id.name);
      }
    },
  }).visit(parsed.program);

  const localeAwareIn = (text: string): boolean => {
    if (LOCALE_SIGNAL_PATTERN.test(text)) return true;
    return [...collatorNames].some((collator) => new RegExp(`\\b${collator}\\.compare\\b`).test(text));
  };

  new Visitor({
    CallExpression(node) {
      if (!direct(node)) return;
      if (node.callee.type !== "MemberExpression" || node.callee.property.type !== "Identifier") return;
      if (node.callee.property.name !== "sort") return;
      const objectText = owner.source.slice(node.callee.object.start, node.callee.object.end);
      const root = rootName(objectText);
      const [comparator] = node.arguments;
      let comparatorKind: ComparatorKind = "none";
      let localeAware = false;
      if (comparator && comparator.type !== "SpreadElement") {
        if (comparator.type === "ArrowFunctionExpression" || comparator.type === "FunctionExpression") {
          comparatorRanges.push({ start: comparator.start, end: comparator.end });
          const bodyText = owner.source.slice(comparator.start, comparator.end).replace(/=>/g, "");
          if (localeAwareIn(bodyText)) {
            comparatorKind = "locale-aware";
            localeAware = true;
          } else if (RELATIONAL_PATTERN.test(bodyText)) {
            comparatorKind = "relational";
          } else if (SUBTRACT_PATTERN.test(bodyText)) {
            comparatorKind = "subtract";
          } else {
            comparatorKind = "other";
          }
        } else {
          comparatorKind = "other";
          const argumentText = owner.source.slice(comparator.start, comparator.end);
          if (localeAwareIn(argumentText)) localeAware = true;
        }
      }
      sorts.push({
        call: owner.source.slice(node.start, node.end).slice(0, 300),
        line: lineAt(owner.source, node.start),
        value: objectText.slice(0, 200),
        valueSource: root === undefined
          ? "unknown"
          : parameters.has(root)
            ? "parameter"
            : objectText.trim() === root
              ? "local"
              : "member",
        comparatorKind,
        localeAware,
      });
    },
  }).visit(parsed.program);

  const comparisons: BlindComparison[] = [];
  new Visitor({
    BinaryExpression(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (!ORDER_OPERATORS.has(node.operator)) return;
      if (node.left.type === "Literal" || node.right.type === "Literal") return;
      const inSortComparator = comparatorRanges.some((range) =>
        node.start >= range.start && node.end <= range.end,
      );
      const memberPair = node.left.type === "MemberExpression" && node.right.type === "MemberExpression";
      if (!inSortComparator && !memberPair) return;
      if (!inSortComparator && !belongsDirectlyToFunction(node, nested)) return;
      comparisons.push({
        expression: owner.source.slice(node.start, node.end).slice(0, 200),
        line: lineAt(owner.source, node.start),
        inSortComparator,
      });
    },
  }).visit(parsed.program);

  if (sorts.length === 0 && comparisons.length === 0) return undefined;
  if (sorts.length > 0 && sorts.every(({ localeAware }) => localeAware) && comparisons.length === 0) {
    return undefined;
  }

  const functionSource = owner.source.slice(candidate.start, candidate.end);
  const moduleSource = `${owner.source.slice(0, candidate.start)}${owner.source.slice(candidate.end)}`;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    sorts: sorts.slice(0, 10),
    comparisons: comparisons.slice(0, 10),
    mitigations: {
      collatorInFunction: LOCALE_SIGNAL_PATTERN.test(functionSource),
      collatorInModule: LOCALE_SIGNAL_PATTERN.test(moduleSource),
    },
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
