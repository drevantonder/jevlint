import { parseSync, Visitor } from "oxc-parser";
import type { Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type TimezoneNaiveArithmeticEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  findings: string[];
  usesNaiveFieldArithmetic: boolean;
  usesFixedDayStep: boolean;
  usesAmbiguousParse: boolean;
  usesLocaleRoundTrip: boolean;
  tzAware: {
    importedFrom: string | null;
    usesTemporal: boolean;
  };
  siblingAwareArithmetic: boolean;
  callers: FunctionCaller[];
};

const NAIVE_GETTERS = new Set([
  "getHours",
  "getMinutes",
  "getSeconds",
  "getMilliseconds",
  "getDate",
  "getDay",
  "getMonth",
  "getFullYear",
  "getYear",
  "setHours",
  "setMinutes",
  "setSeconds",
  "setMilliseconds",
  "setDate",
  "setMonth",
  "setFullYear",
  "setYear",
]);

const FIXED_DAY_STEP = new Set(["86400000", "86400", "3600000", "3600"]);

const TZ_AWARE_SOURCES = ["luxon", "date-fns-tz", "temporal", "@js-temporal"];

function rootName(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    return expression.object.type === "Super" ? undefined : rootName(expression.object);
  }
  if (expression.type === "ChainExpression") return rootName(expression.expression);
  if (expression.type === "ParenthesizedExpression") return rootName(expression.expression);
  return undefined;
}

function hasOffsetSuffix(raw: string): boolean {
  const text = raw.slice(1, -1);
  return /([zZ]|GMT|UTC|[+-]\d{2}:?\d{2})$/.test(text.trim());
}

export function buildTimezoneNaiveArithmeticEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): TimezoneNaiveArithmeticEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const findings: string[] = [];
  const flags = { naive: false, dayStep: false, ambiguous: false, locale: false, temporal: false };
  let seenLocaleFormat = false;
  let seenStringDateConstruction = false;

  const push = (node: { start: number; end: number }): void => {
    if (findings.length < 20) findings.push(owner.source.slice(node.start, node.end).slice(0, 240));
  };

  let functionDepth = 0;
  const isDirect = (node: FunctionNode): boolean => node.start === fn.start && node.end === fn.end;
  const enterFunction = (node: FunctionNode): void => {
    if (isDirect(node)) functionDepth = 1;
    else if (functionDepth > 0) functionDepth += 1;
  };
  const exitFunction = (node: FunctionNode): void => {
    if (functionDepth === 0) return;
    functionDepth -= 1;
    if (isDirect(node)) functionDepth = 0;
  };

  new Visitor({
    ArrowFunctionExpression: enterFunction,
    "ArrowFunctionExpression:exit": exitFunction,
    FunctionDeclaration: enterFunction,
    "FunctionDeclaration:exit": exitFunction,
    FunctionExpression: enterFunction,
    "FunctionExpression:exit": exitFunction,
    BinaryExpression(node) {
      if (functionDepth !== 1) return;
      if (node.operator !== "+" && node.operator !== "-") return;
      const literal = node.left.type === "Literal" ? node.left : node.right.type === "Literal" ? node.right : undefined;
      if (!literal) return;
      const raw = owner.source.slice(literal.start, literal.end);
      if (!FIXED_DAY_STEP.has(raw)) return;
      flags.dayStep = true;
      push(node);
    },
    CallExpression(node) {
      if (functionDepth !== 1) return;
      const callee = node.callee.type === "ChainExpression" ? node.callee.expression : node.callee;
      if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
        if (NAIVE_GETTERS.has(callee.property.name)) {
          flags.naive = true;
          push(node);
        }
        if (
          callee.property.name === "toLocaleString"
          || callee.property.name === "toLocaleDateString"
          || callee.property.name === "toLocaleTimeString"
        ) seenLocaleFormat = true;
      }
      if (callee.type === "Identifier" && callee.name === "Temporal") flags.temporal = true;
      const root = rootName(node.callee);
      if (root === "Temporal") flags.temporal = true;
    },
    NewExpression(node) {
      if (functionDepth !== 1) return;
      if (node.callee.type !== "Identifier" || node.callee.name !== "Date") return;
      const [first] = node.arguments;
      if (first?.type === "Literal") {
        const raw = owner.source.slice(first.start, first.end);
        if (raw.startsWith("\"") || raw.startsWith("'")) {
          if (!hasOffsetSuffix(raw)) {
            flags.ambiguous = true;
            push(node);
          }
        }
      } else if (first !== undefined) {
        seenStringDateConstruction = true;
      }
    },
  }).visit(parsed.program);

  if (seenLocaleFormat && seenStringDateConstruction) flags.locale = true;

  if (!flags.naive && !flags.dayStep && !flags.ambiguous && !flags.locale) return undefined;

  const imports = moduleImports(parsed.program);
  const awareImport = imports.find(({ source }) =>
    TZ_AWARE_SOURCES.some((token) => source.includes(token))
  );
  let siblingAwareArithmetic = false;
  for (const file of projectFiles) {
    if (file.filePath === owner.filePath) continue;
    if (
      file.source.includes("Temporal.")
      || file.source.includes("luxon")
      || file.source.includes("date-fns-tz")
      || file.source.includes("date-fns/utc")
    ) {
      siblingAwareArithmetic = true;
      break;
    }
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    findings,
    usesNaiveFieldArithmetic: flags.naive,
    usesFixedDayStep: flags.dayStep,
    usesAmbiguousParse: flags.ambiguous,
    usesLocaleRoundTrip: flags.locale,
    tzAware: {
      importedFrom: awareImport?.source ?? null,
      usesTemporal: flags.temporal,
    },
    siblingAwareArithmetic,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
