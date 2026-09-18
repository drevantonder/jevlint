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

export type MisdirectingThrow = {
  message: string;
  line: number;
  namedCause: string;
  insideCatch: boolean;
  causeCheckedInScope: boolean;
  hasCauseLinkage: boolean;
  operation: string;
};

export type MisdirectingErrorMessageEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  throws: MisdirectingThrow[];
  callers: FunctionCaller[];
};

const MAX_THROWS = 8;
const MAX_EXCERPT_CHARS = 240;

// A throw asserts one of these causes when its message names it.
const CAUSES: { cause: string; keywords: RegExp; checkSignals: RegExp }[] = [
  {
    cause: "network",
    keywords: /network|connection|offline|unreachable|dns\b|socket|econn|fetch fail|internet/i,
    checkSignals: /fetch|Response|request|axios|XMLHttpRequest|\.ok\b|status|online|offline/i,
  },
  {
    cause: "timeout",
    keywords: /timed?\s*out|timeout|deadline exceeded/i,
    checkSignals: /timeout|deadline|AbortSignal|abort|elapsed|duration/i,
  },
  {
    cause: "auth",
    keywords: /unauthori[sz]ed|forbidden|permission|denied|login|credential|token|auth\b/i,
    checkSignals: /auth|token|permission|role|session|login|401|403/i,
  },
  {
    cause: "not-found",
    keywords: /not found|missing|does not exist|no such|404\b/i,
    checkSignals: /null|undefined|exists|found|\.get\(|lookup|404\b/i,
  },
  {
    cause: "parse",
    keywords: /\bparse\b|invalid json|malformed|syntax error|unexpected token/i,
    checkSignals: /JSON\.parse|parse|SyntaxError|try\b|catch\b/i,
  },
  {
    cause: "disk",
    keywords: /disk|enospc|no space|file system|eio\b/i,
    checkSignals: /fs\b|writeFile|disk|enospc|eio\b/i,
  },
  {
    cause: "memory",
    keywords: /out of memory|heap|memory/i,
    checkSignals: /memory|heap|buffer|allocat/i,
  },
  {
    cause: "invalid-input",
    keywords: /invalid|bad request|must be|required|expected/i,
    checkSignals: /valid|typeof|instanceof|Array\.isArray|check|assert|throw\b/i,
  },
];

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

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
    // A dynamic side still leaves the static prefix asserting a cause.
    const left = staticText(node.left);
    if (left !== undefined && left.trim().length > 0) return left;
    return staticText(node.right);
  }
  return undefined;
}

export function buildMisdirectingErrorMessageEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): MisdirectingErrorMessageEvidence | undefined {
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

  const throws: MisdirectingThrow[] = [];
  const visitThrow = (
    node: { start: number; end: number },
    operation: string,
    message: string | undefined,
    hasCauseLinkage: boolean,
    caughtNames: string[],
  ): void => {
    if (throws.length >= MAX_THROWS) return;
    if (!message || message.trim().length === 0) return;
    const cause = CAUSES.find(({ keywords }) => keywords.test(message));
    // Messages asserting no specific cause belong to the empty-error family, not here.
    if (!cause) return;
    const scopeSource = candidate.source;
    const referencesCaught = caughtNames.some((caught) => new RegExp(`\\b${caught}\\b`).test(message));
    throws.push({
      message: message.slice(0, MAX_EXCERPT_CHARS),
      line: lineAt(owner.source, node.start),
      namedCause: cause.cause,
      insideCatch: caughtNames.length > 0,
      causeCheckedInScope: cause.checkSignals.test(scopeSource) || caughtNames.length > 0,
      hasCauseLinkage: hasCauseLinkage || referencesCaught,
      operation: operation.slice(0, MAX_EXCERPT_CHARS),
    });
  };

  const catchStack: { param: string | null }[] = [];
  new Visitor({
    CatchClause(node) {
      catchStack.push({ param: node.param?.type === "Identifier" ? node.param.name : null });
    },
    "CatchClause:exit"() {
      catchStack.pop();
    },
    ThrowStatement(node) {
      if (!direct(node)) return;
      if (node.argument?.type !== "NewExpression") {
        const caught = catchStack.map(({ param }) => param).filter((param): param is string => param !== null);
        visitThrow(
          node,
          owner.source.slice(node.start, node.end),
          node.argument === undefined || node.argument === null ? undefined : staticText(node.argument),
          false,
          caught,
        );
        return;
      }
      const callee = owner.source.slice(node.argument.callee.start, node.argument.callee.end);
      if (!/(^|\.)(Error|TypeError|RangeError|SyntaxError|DOMException)$/.test(callee)) return;
      const [first, second] = node.argument.arguments;
      const message = first === undefined ? undefined : staticText(first);
      const hasCauseLinkage = second !== undefined
        && second.type !== "SpreadElement"
        && /cause/.test(owner.source.slice(second.start, second.end));
      const caught = catchStack.map(({ param }) => param).filter((param): param is string => param !== null);
      visitThrow(node, owner.source.slice(node.start, node.end), message, hasCauseLinkage, caught);
    },
  }).visit(parsed.program);

  if (throws.length === 0) return undefined;
  return {
    function: {
      name: name ?? null,
      exported: name !== undefined && isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    throws,
    callers: name === undefined ? [] : findFunctionCallers(owner.filePath, name, projectFiles),
  };
}
