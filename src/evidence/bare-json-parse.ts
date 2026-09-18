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

export type JsonParseProvenance = "external" | "local" | "unknown";

export type JsonParseSite = {
  expression: string;
  argument: string;
  inputProvenance: JsonParseProvenance;
  insideTry: boolean;
};

export type BareJsonParseEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  parseSites: JsonParseSite[];
  hasContextualCatch: boolean;
  hasSchemaValidation: boolean;
  validationLibrary: string | null;
  hasSafeWrapper: boolean;
  callers: FunctionCaller[];
};

const EXTERNAL_INPUT = /\b(req|request|res|response|body|payload|raw|rawBody|rawText|text|input|message|event|chunk|buffer|content|file|result|data|localStorage|sessionStorage)\b/i;

const LOCAL_INPUT = /^\s*['"`[{]|JSON\.stringify\s*\(|\b(DEFAULT|FALLBACK|FIXTURE|SAMPLE|EXAMPLE|CONSTANT|EMPTY|BLANK)\b/;

const SCHEMA_LIBRARIES = ["zod", "ajv", "yup", "joi", "valibot", "superstruct", "arktype"];

const SAFE_WRAPPER = /\b(safe\w*parse\w*|parse\w*safe|tryParse\w*|parseJson\w*|parse_JSON\w*|decodeJson\w*)\b/i;

function classifyProvenance(argument: string): JsonParseProvenance {
  if (LOCAL_INPUT.test(argument)) return "local";
  if (EXTERNAL_INPUT.test(argument)) return "external";
  return "unknown";
}

function findValidationLibrary(source: string): string | null {
  for (const library of SCHEMA_LIBRARIES) {
    if (new RegExp(`\\b${library}\\b`).test(source)) return library;
  }
  return null;
}

export function buildBareJsonParseEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): BareJsonParseEvidence | undefined {
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
    node.start >= candidate.start
    && node.end <= candidate.end
    && belongsDirectlyToFunction(node, nested);

  const tryRanges: Array<{ start: number; end: number }> = [];
  const sites: Array<{ start: number; end: number; argument: string }> = [];

  new Visitor({
    TryStatement(node) {
      if (direct(node)) tryRanges.push({ start: node.start, end: node.end });
    },
    CallExpression(node) {
      if (!direct(node)) return;
      const callee = node.callee.type === "ChainExpression" ? node.callee.expression : node.callee;
      if (callee.type !== "MemberExpression") return;
      if (callee.object.type !== "Identifier" || callee.object.name !== "JSON") return;
      const method = callee.property.type === "Identifier"
        ? callee.property.name
        : callee.property.type === "Literal" ? String(callee.property.value) : null;
      if (method !== "parse") return;
      const first = node.arguments[0];
      const argument = first
        ? owner.source.slice(first.start, first.end).slice(0, 200)
        : "";
      sites.push({ start: node.start, end: node.end, argument });
    },
  }).visit(parsed.program);

  if (sites.length === 0) return undefined;

  const body = owner.source.slice(fn.start, fn.end);
  const validationLibrary = findValidationLibrary(owner.source);
  const hasSchemaValidation = /\.safeParse\s*\(/.test(body)
    || (validationLibrary !== null && /\b(validate|compile)\s*\(/.test(body))
    || (validationLibrary !== null && /\w+\.parse\s*\(/.test(body.replace(/JSON\.parse\s*\(/g, "")));
  const hasSafeWrapper = SAFE_WRAPPER.test(body.replace(/JSON\.parse/g, ""));
  const hasContextualCatch = /catch[^{]*\{[\s\S]*?throw\b/.test(body);

  const parseSites: JsonParseSite[] = sites.slice(0, 20).map((site) => ({
    expression: owner.source.slice(site.start, site.end).slice(0, 240),
    argument: site.argument,
    inputProvenance: classifyProvenance(site.argument),
    insideTry: tryRanges.some((range) => site.start >= range.start && site.end <= range.end),
  }));

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    parseSites,
    hasContextualCatch,
    hasSchemaValidation,
    validationLibrary,
    hasSafeWrapper,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
