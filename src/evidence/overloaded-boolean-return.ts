import { parseSync, Visitor } from "oxc-parser";
import type { Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";

export type BooleanReturnPoint = {
  expression: string;
  condition: string | null;
  kind: "literal" | "boolean-expression" | "property-read" | "call";
  line: number;
};

export type BooleanReturnCaller = {
  filePath: string;
  callerFunction: string | null;
  call: string;
  line: number;
  branchReading: string | null;
};

export type OverloadedBooleanReturnEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  booleanReturns: BooleanReturnPoint[];
  callers: BooleanReturnCaller[];
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function booleanReturnKind(expression: Expression): BooleanReturnPoint["kind"] | undefined {
  if (expression.type === "Literal" && (expression.value === true || expression.value === false)) {
    return "literal";
  }
  if (expression.type === "UnaryExpression" && expression.operator === "!") return "boolean-expression";
  if (
    expression.type === "BinaryExpression"
    && ["==", "!=", "===", "!==", "<", ">", "<=", ">=", "in", "instanceof"].includes(expression.operator)
  ) return "boolean-expression";
  if (expression.type === "LogicalExpression") return "boolean-expression";
  if (expression.type === "Identifier" || expression.type === "MemberExpression") return "property-read";
  if (expression.type === "CallExpression") return "call";
  return undefined;
}

type BranchSite = {
  testStart: number;
  testEnd: number;
  consequent: string;
  alternate: string | null;
};

function branchSites(source: string, filePath: string): BranchSite[] {
  const parsed = parseSync(filePath, source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return [];
  const sites: BranchSite[] = [];
  new Visitor({
    IfStatement(node) {
      sites.push({
        testStart: node.test.start,
        testEnd: node.test.end,
        consequent: source.slice(node.consequent.start, node.consequent.end).slice(0, 300),
        alternate: node.alternate ? source.slice(node.alternate.start, node.alternate.end).slice(0, 300) : null,
      });
    },
    ConditionalExpression(node) {
      sites.push({
        testStart: node.test.start,
        testEnd: node.test.end,
        consequent: source.slice(node.consequent.start, node.consequent.end).slice(0, 300),
        alternate: source.slice(node.alternate.start, node.alternate.end).slice(0, 300),
      });
    },
  }).visit(parsed.program);
  return sites;
}

export function buildOverloadedBooleanReturnEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): OverloadedBooleanReturnEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn || !fn.body) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  const nested = nestedFunctionRanges(parsed.program, candidate);

  const direct = (start: number, end: number): boolean =>
    start >= candidate.start
    && end <= candidate.end
    && !nested.some((range) => range.start <= start && range.end >= end);

  const conditions: Array<{ condition: string; start: number; end: number }> = [];
  new Visitor({
    IfStatement(node) {
      if (!direct(node.start, node.end)) return;
      conditions.push({
        condition: owner.source.slice(node.test.start, node.test.end),
        start: node.start,
        end: node.end,
      });
    },
  }).visit(parsed.program);

  const booleanReturns: BooleanReturnPoint[] = [];
  new Visitor({
    ReturnStatement(node) {
      if (!node.argument || !direct(node.start, node.end)) return;
      const kind = booleanReturnKind(node.argument);
      if (!kind) return;
      const enclosing = conditions
        .filter((context) => context.start <= node.start && context.end >= node.end)
        .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0];
      booleanReturns.push({
        expression: owner.source.slice(node.argument.start, node.argument.end),
        condition: enclosing?.condition ?? null,
        kind,
        line: lineAt(owner.source, node.start),
      });
    },
  }).visit(parsed.program);

  if (booleanReturns.length < 2) return undefined;
  const distinctConditions = new Set(booleanReturns.map((item) => item.condition ?? "unconditional"));
  if (distinctConditions.size < 2) return undefined;

  const rawCallers = findFunctionCallers(candidate.filePath, name, projectFiles);
  if (rawCallers.length === 0) return undefined;

  const sitesByFile = new Map<string, BranchSite[]>();
  const aliasesByFile = new Map<string, Set<string>>();
  const functionsByFile = new Map<string, Array<{ name: string; start: number; end: number }>>();
  const callers: BooleanReturnCaller[] = rawCallers.map((caller) => {
    const file = projectFiles.find((item) => item.filePath === caller.filePath);
    if (!file) return { ...caller, callerFunction: null, branchReading: null };
    let sites = sitesByFile.get(file.filePath);
    let aliases = aliasesByFile.get(file.filePath);
    let functions = functionsByFile.get(file.filePath);
    if (!sites || !aliases || !functions) {
      sites = branchSites(file.source, file.filePath);
      aliases = new Set<string>();
      functions = [];
      const parsedCaller = parseSync(file.filePath, file.source, { range: true });
      if (!parsedCaller.errors.some((error) => error.severity === "Error")) {
        const foundAliases = aliases;
        const foundFunctions = functions;
        new Visitor({
          VariableDeclarator(node) {
            if (node.id.type !== "Identifier" || !node.init) return;
            if (file.source.slice(node.init.start, node.init.end).includes(name)) {
              foundAliases.add(node.id.name);
            }
            if (node.init.type === "ArrowFunctionExpression" || node.init.type === "FunctionExpression") {
              foundFunctions.push({ name: node.id.name, start: node.init.start, end: node.init.end });
            }
          },
          FunctionDeclaration(node) {
            if (node.id) foundFunctions.push({ name: node.id.name, start: node.start, end: node.end });
          },
        }).visit(parsedCaller.program);
      }
      sitesByFile.set(file.filePath, sites);
      aliasesByFile.set(file.filePath, aliases);
      functionsByFile.set(file.filePath, functions);
    }
    const lineStarts = [0];
    for (let index = 0; index < file.source.length; index += 1) {
      if (file.source[index] === "\n") lineStarts.push(index + 1);
    }
    const lineStart = lineStarts[caller.line - 1] ?? 0;
    const callOffset = file.source.indexOf(caller.call, lineStart);
    const enclosing = callOffset < 0 ? undefined : sites
      .filter((site) => site.testStart <= callOffset && callOffset <= site.testEnd)
      .sort((left, right) => (left.testEnd - left.testStart) - (right.testEnd - right.testStart))[0];
    const testOf = (site: BranchSite): string => file.source.slice(site.testStart, site.testEnd);
    const match = enclosing
      ?? sites.find((site) => [...aliases].some((candidate) => new RegExp(`\\b${candidate}\\b`).test(testOf(site))))
      ?? sites.find((site) => new RegExp(`\\b${name}\\b`).test(testOf(site)));
    const callerFunction = callOffset < 0 ? null : functions
      .filter((fn) => fn.start <= callOffset && callOffset <= fn.end)
      .sort((left, right) => (left.end - left.start) - (right.end - right.start))[0]?.name ?? null;
    return {
      filePath: caller.filePath,
      callerFunction,
      call: caller.call,
      line: caller.line,
      branchReading: match
        ? `${callerFunction ?? "caller"} assumes, when truthy: ${match.consequent}${match.alternate ? `; otherwise: ${match.alternate}` : ""}`
        : null,
    };
  });

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    booleanReturns,
    callers,
  };
}
