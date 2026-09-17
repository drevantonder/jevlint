import { parseSync, Visitor } from "oxc-parser";
import type { CallExpression, Expression, NewExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type RegexPattern = {
  pattern: string;
  flags: string;
  line: number;
  origin: "literal" | "RegExp";
  nestedQuantifier: boolean;
  quantifiedAlternation: boolean;
};

export type TestedValue = {
  call: string;
  line: number;
  value: string;
  valueSource: "parameter" | "request-member" | "other";
};

export type AdversarialRegexEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    parameters: string[];
  };
  patterns: RegexPattern[];
  testedValues: TestedValue[];
  mitigations: {
    lengthCap: boolean;
    timeoutMention: boolean;
    linearEngine: boolean;
  };
  callers: FunctionCaller[];
};

const NESTED_QUANTIFIER_PATTERN = /\([^()]*[+*{][^()]*\)[+*?{]|\{[^}]*\}[+*?]/;
const ALTERNATION_PATTERN = /\([^()]*\|[^()]*\)[+*?]?/;
const REQUEST_MEMBER_PATTERN = /\b(req|request|body|query|params|input|message|payload|formData|searchParams)\b/;
const LENGTH_CAP_PATTERN = /\.length\s*[<>]|\.slice\s*\(\s*0\s*,/;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function namedParameter(parameter: FunctionNode["params"][number]): string | undefined {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  if (value.type === "Identifier") return value.name;
  if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
    return value.left.name;
  }
  if (value.type === "RestElement" && value.argument.type === "Identifier") {
    return value.argument.name;
  }
  return undefined;
}

function regexField(node: Expression, source: string): { pattern: string; flags: string } | undefined {
  if (node.type !== "Literal") return undefined;
  const raw = source.slice(node.start, node.end);
  if (!raw.startsWith("/")) return undefined;
  const closing = raw.lastIndexOf("/");
  if (closing <= 0) return undefined;
  return { pattern: raw.slice(1, closing), flags: raw.slice(closing + 1) };
}

function stringInner(node: Expression, source: string): string | undefined {
  if (node.type === "TemplateLiteral" && node.expressions.length > 0) return undefined;
  const raw = source.slice(node.start, node.end);
  const quote = raw[0];
  if (quote !== "\"" && quote !== "'" && quote !== "`") return undefined;
  if (raw.length < 2 || raw[raw.length - 1] !== quote) return undefined;
  return raw.slice(1, -1);
}

function classifyValue(value: Expression, parameters: Set<string>, source: string): TestedValue["valueSource"] {
  if (value.type === "Identifier" && parameters.has(value.name)) return "parameter";
  if (REQUEST_MEMBER_PATTERN.test(source.slice(value.start, value.end))) return "request-member";
  return "other";
}

function calleeRoot(call: CallExpression | NewExpression, source: string): string {
  return source.slice(call.callee.start, call.callee.end);
}

export function buildAdversarialRegexEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): AdversarialRegexEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  const parameters = fn.params.flatMap((parameter) => {
    const parameterName = namedParameter(parameter);
    return parameterName === undefined ? [] : [parameterName];
  });
  const parameterSet = new Set(parameters);

  const nested = nestedFunctionRanges(parsed.program, fn);
  const direct = (node: { start: number; end: number }): boolean =>
    node.start >= candidate.start && node.end <= candidate.end
    && belongsDirectlyToFunction(node, nested);

  const patterns: RegexPattern[] = [];
  const patternVariables = new Map<string, number>();
  new Visitor({
    Literal(node) {
      if (!direct(node)) return;
      const regex = regexField(node, owner.source);
      if (!regex) return;
      patterns.push({
        ...regex,
        line: lineAt(owner.source, node.start),
        origin: "literal",
        nestedQuantifier: NESTED_QUANTIFIER_PATTERN.test(regex.pattern),
        quantifiedAlternation: ALTERNATION_PATTERN.test(regex.pattern),
      });
    },
    CallExpression(call) {
      if (!direct(call)) return;
      const root = calleeRoot(call, owner.source);
      if (root !== "RegExp" || call.arguments.length === 0) return;
      const [patternArgument, flagsArgument] = call.arguments;
      if (!patternArgument || patternArgument.type === "SpreadElement") return;
      const patternText = stringInner(patternArgument, owner.source);
      if (patternText === undefined) return;
      const flags = flagsArgument && flagsArgument.type !== "SpreadElement"
        ? stringInner(flagsArgument, owner.source) ?? ""
        : "";
      patterns.push({
        pattern: patternText,
        flags,
        line: lineAt(owner.source, call.start),
        origin: "RegExp",
        nestedQuantifier: NESTED_QUANTIFIER_PATTERN.test(patternText),
        quantifiedAlternation: ALTERNATION_PATTERN.test(patternText),
      });
    },
    NewExpression(call) {
      if (!direct(call)) return;
      const root = calleeRoot(call, owner.source);
      if (root !== "RegExp" || call.arguments.length === 0) return;
      const [patternArgument, flagsArgument] = call.arguments;
      if (!patternArgument || patternArgument.type === "SpreadElement") return;
      const patternText = stringInner(patternArgument, owner.source);
      if (patternText === undefined) return;
      const flags = flagsArgument && flagsArgument.type !== "SpreadElement"
        ? stringInner(flagsArgument, owner.source) ?? ""
        : "";
      patterns.push({
        pattern: patternText,
        flags,
        line: lineAt(owner.source, call.start),
        origin: "RegExp",
        nestedQuantifier: NESTED_QUANTIFIER_PATTERN.test(patternText),
        quantifiedAlternation: ALTERNATION_PATTERN.test(patternText),
      });
    },
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || !node.init || !direct(node)) return;
      if (regexField(node.init, owner.source)) {
        patternVariables.set(node.id.name, patterns.length);
        return;
      }
      if (
        (node.init.type === "CallExpression" || node.init.type === "NewExpression")
        && calleeRoot(node.init, owner.source) === "RegExp"
      ) patternVariables.set(node.id.name, patterns.length);
    },
  }).visit(parsed.program);

  const risky = patterns.some(({ nestedQuantifier, quantifiedAlternation }) =>
    nestedQuantifier || quantifiedAlternation,
  );
  if (!risky) return undefined;

  const testedValues: TestedValue[] = [];
  new Visitor({
    CallExpression(call) {
      if (!direct(call)) return;
      if (call.callee.type === "MemberExpression") {
        const object = owner.source.slice(call.callee.object.start, call.callee.object.end);
        const property = call.callee.property.type === "Identifier"
          ? call.callee.property.name
          : null;
        if (property === "test" || property === "exec") {
          if (!patternVariables.has(object) && !object.includes("/")) return;
          const [value] = call.arguments;
          if (!value || value.type === "SpreadElement") return;
          testedValues.push({
            call: owner.source.slice(call.start, call.end).slice(0, 200),
            line: lineAt(owner.source, call.start),
            value: owner.source.slice(value.start, value.end).slice(0, 120),
            valueSource: classifyValue(value, parameterSet, owner.source),
          });
          return;
        }
        if (property === "match" || property === "search" || property === "replace" || property === "split") {
          const [patternArgument] = call.arguments;
          const patternText = patternArgument
            ? owner.source.slice(patternArgument.start, patternArgument.end)
            : "";
          const ownPattern = [...patternVariables.keys()].some((variable) =>
            new RegExp(`\\b${variable}\\b`).test(patternText)
          ) || patternText.includes("/");
          if (!ownPattern) return;
          testedValues.push({
            call: owner.source.slice(call.start, call.end).slice(0, 200),
            line: lineAt(owner.source, call.start),
            value: object.slice(0, 120),
            valueSource: REQUEST_MEMBER_PATTERN.test(object)
              ? "request-member"
              : parameterSet.has(object)
                ? "parameter"
                : "other",
          });
        }
      }
    },
  }).visit(parsed.program);

  const functionSource = owner.source.slice(candidate.start, candidate.end);
  const imports = moduleImports(parsed.program);
  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
      parameters,
    },
    patterns: patterns.slice(0, 10),
    testedValues: testedValues.slice(0, 10),
    mitigations: {
      lengthCap: LENGTH_CAP_PATTERN.test(functionSource),
      timeoutMention: /timeout/i.test(functionSource),
      linearEngine: imports.some(({ source }) => /re2/.test(source))
        || /new\s+RE2\b|\bre2\b/i.test(owner.source),
    },
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
