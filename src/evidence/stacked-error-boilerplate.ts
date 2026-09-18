import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Argument, Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type StackedErrorConstruction = {
  operation: string;
  message: string;
  matchedBoilerplate: string[];
  boilerplateOnly: boolean;
  hasCause: boolean;
  insideCatch: boolean;
  interpolatesCaughtMessage: boolean;
  hasSpecificInterpolation: boolean;
};

export type StackedErrorBoilerplateEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  constructions: StackedErrorConstruction[];
  callers: FunctionCaller[];
};

const MAX_CONSTRUCTIONS = 8;
const MAX_EXCERPT_CHARS = 240;

// Phrases that restate the obvious instead of adding information about the failure.
const BOILERPLATE: { phrase: string; pattern: RegExp }[] = [
  { phrase: "failed to", pattern: /failed to/i },
  { phrase: "failure to", pattern: /failure to/i },
  { phrase: "could not", pattern: /could\s+not/i },
  { phrase: "couldn't", pattern: /couldn'?t/i },
  { phrase: "unable to", pattern: /unable to/i },
  { phrase: "error occurred", pattern: /errors? occurred/i },
  { phrase: "something went wrong", pattern: /something went wrong/i },
  { phrase: "went wrong", pattern: /went wrong/i },
  { phrase: "error while", pattern: /errors?\s+while\b/i },
  { phrase: "error when", pattern: /errors?\s+when\b/i },
  { phrase: "error during", pattern: /errors?\s+during\b/i },
  { phrase: "unsuccessful", pattern: /unsuccessful/i },
];

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "of",
  "for",
  "while",
  "when",
  "during",
  "with",
  "and",
  "or",
  "in",
  "on",
  "at",
  "by",
  "from",
  "something",
  "occurred",
  "error",
  "errors",
  "please",
  "again",
  "try",
  "anew",
]);

const GLOBAL_IDENTIFIERS = new Set([
  "String",
  "Number",
  "Boolean",
  "JSON",
  "Array",
  "Object",
  "Math",
  "Error",
  "undefined",
  "null",
  "true",
  "false",
]);

function quotedString(raw: string | null): string | undefined {
  if (raw === null || raw === "") return undefined;
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === "\"" || first === "'") && last === first) return raw.slice(1, -1);
  return undefined;
}

function staticText(node: Expression | Argument): string | undefined {
  if (node.type === "Literal") return quotedString(node.raw);
  if (node.type === "TemplateLiteral") {
    const text = node.quasis.map((quasi) => quasi.value.cooked ?? "").join(" ").trim();
    return text.length > 0 ? text : undefined;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = staticText(node.left);
    if (left !== undefined && left.trim().length > 0) return left;
    return staticText(node.right);
  }
  return undefined;
}

function matchedPhrases(message: string): string[] {
  const seen = new Set<string>();
  for (const { phrase, pattern } of BOILERPLATE) {
    if (pattern.test(message)) {
      // "something went wrong" already covers "went wrong"; keep the longest.
      if (phrase === "went wrong" && seen.has("something went wrong")) continue;
      if (phrase === "something went wrong") seen.delete("went wrong");
      seen.add(phrase);
    }
  }
  return [...seen];
}

function isBoilerplateOnly(message: string, matched: string[]): boolean {
  let rest = message.toLowerCase();
  for (const phrase of matched) {
    rest = rest.replaceAll(phrase, " ");
  }
  const words = rest
    .replaceAll(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
  return words.length === 0;
}

function stripStringLiterals(code: string): string {
  return code.replaceAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, " ");
}

type InterpolationSignals = {
  interpolatesCaughtMessage: boolean;
  hasSpecificInterpolation: boolean;
};

function interpolationSignals(
  node: Expression | Argument,
  source: string,
  caughtNames: string[],
): InterpolationSignals {
  let interpolatesCaughtMessage = false;
  let hasSpecificInterpolation = false;
  const examine = (code: string): void => {
    const bare = stripStringLiterals(code);
    const caughtRef = caughtNames.some((name) => new RegExp(`\\b${name}\\b`).test(bare));
    if (caughtRef) {
      // The outer message reprints the caught error, duplicating the cause chain.
      interpolatesCaughtMessage = true;
      return;
    }
    let rest = bare;
    for (const name of caughtNames) {
      rest = rest.replaceAll(new RegExp(`\\b${name}\\b`, "g"), " ");
    }
    rest = rest.replaceAll(/\.\s*[A-Za-z_$][\w$]*/g, " ");
    const tokens = rest.match(/[A-Za-z_$][\w$]*/g) ?? [];
    if (tokens.some((token) => !GLOBAL_IDENTIFIERS.has(token))) {
      hasSpecificInterpolation = true;
    }
  };

  if (node.type === "TemplateLiteral") {
    for (const expression of node.expressions) {
      examine(source.slice(expression.start, expression.end));
    }
    return { interpolatesCaughtMessage, hasSpecificInterpolation };
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const examineSide = (side: Expression): void => {
      if (side.type === "Literal") return;
      examine(source.slice(side.start, side.end));
    };
    examineSide(node.left);
    examineSide(node.right);
    return { interpolatesCaughtMessage, hasSpecificInterpolation };
  }
  if (node.type !== "Literal") {
    examine(source.slice(node.start, node.end));
  }
  return { interpolatesCaughtMessage, hasSpecificInterpolation };
}

function isErrorCallee(calleeSource: string): boolean {
  return /(^|\.)(Error|TypeError|RangeError|SyntaxError|URIError|AggregateError|DOMException)$/.test(
    calleeSource,
  );
}

export function buildStackedErrorBoilerplateEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): StackedErrorBoilerplateEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const direct = (node: { start: number; end: number }): boolean =>
    node.start >= candidate.start
    && node.end <= candidate.end
    && !nested.some((range) => range.start <= node.start && range.end >= node.end);

  const constructions: StackedErrorConstruction[] = [];
  const visitConstruction = (
    node: { start: number; end: number },
    messageNode: Expression | Argument | undefined,
    optionsNode: Argument | undefined,
    caughtNames: string[],
  ): void => {
    if (constructions.length >= MAX_CONSTRUCTIONS) return;
    if (messageNode === undefined) return;
    const message = staticText(messageNode);
    if (!message || message.trim().length === 0) return;
    const matched = matchedPhrases(message);
    const { interpolatesCaughtMessage, hasSpecificInterpolation } = interpolationSignals(
      messageNode,
      owner.source,
      caughtNames,
    );
    // A specific message with no boilerplate and no cause duplication is outside this rule.
    if (matched.length === 0 && !interpolatesCaughtMessage) return;
    const hasCause = optionsNode !== undefined
      && optionsNode.type !== "SpreadElement"
      && /cause/.test(owner.source.slice(optionsNode.start, optionsNode.end));
    constructions.push({
      operation: owner.source.slice(node.start, node.end).slice(0, MAX_EXCERPT_CHARS),
      message: message.slice(0, MAX_EXCERPT_CHARS),
      matchedBoilerplate: matched,
      boilerplateOnly: isBoilerplateOnly(message, matched),
      hasCause,
      insideCatch: caughtNames.length > 0,
      interpolatesCaughtMessage,
      hasSpecificInterpolation,
    });
  };

  const catchStack: { param: string | null }[] = [];
  const caughtNames = (): string[] =>
    catchStack.map(({ param }) => param).filter((param): param is string => param !== null);
  new Visitor({
    CatchClause(node) {
      catchStack.push({ param: node.param?.type === "Identifier" ? node.param.name : null });
    },
    "CatchClause:exit"() {
      catchStack.pop();
    },
    ThrowStatement(node) {
      if (!direct(node)) return;
      const caught = caughtNames();
      if (node.argument?.type !== "NewExpression" && node.argument?.type !== "CallExpression") {
        return;
      }
      const callee = owner.source.slice(node.argument.callee.start, node.argument.callee.end);
      if (!isErrorCallee(callee)) return;
      const [first, second] = node.argument.arguments;
      visitConstruction(node, first, second, caught);
    },
  }).visit(parsed.program);

  if (constructions.length === 0) return undefined;
  return {
    function: {
      name: name ?? null,
      exported: name !== undefined && isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    constructions,
    callers: name === undefined ? [] : findFunctionCallers(owner.filePath, name, projectFiles),
  };
}
