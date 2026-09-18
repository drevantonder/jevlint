import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type AmbiguousQuantity = {
  name: string;
  source: string;
  annotation: string | null;
  literalCallers: string[];
};

export type UnitAmbiguousQuantityEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  quantities: AmbiguousQuantity[];
  callers: FunctionCaller[];
};

const QUANTITY_STEMS = new Set([
  "timeout",
  "delay",
  "interval",
  "duration",
  "ttl",
  "deadline",
  "period",
  "expiry",
  "expiration",
  "retention",
  "age",
  "size",
  "length",
  "distance",
  "weight",
  "height",
  "width",
  "depth",
  "radius",
  "speed",
  "velocity",
  "latency",
  "lifetime",
]);

const COUNT_WORDS = new Set(["count", "index", "idx", "page", "num", "number"]);

const UNIT_SUFFIX = /(Ms|Millis|Milliseconds|Micros|Nanos|Sec|Secs|Second|Seconds|Minute|Minutes|Hour|Hours|Day|Days|KB|MB|GB|TB|Bytes)$/;

const UNIT_WORD = /\b(milliseconds?|microseconds?|nanoseconds?|seconds?|minutes?|hours?|days?|bytes?|kilobytes?|megabytes?|gigabytes?|pixels?|meters?|metres?|kilometers?|kilometres?|miles?|pounds?|grams?|kilos?|\bms\b|per second|per minute)\b/i;

const NAMED_CONVERSION = /secToMs|msToSec|toMs\b|toSeconds?|toMillis|asMillis|asSeconds|convert[A-Z].*(Ms|Sec|Bytes|KB)|fromSeconds|fromMillis/i;

const SCALE_OPERATION = /[*/]\s*1024\b|\b1024\s*[*/]|[*/]\s*1000\b|\b1000\s*[*/]/;

function camelWords(name: string): string[] {
  return name.split(/(?=[A-Z0-9])|_/).map((word) => word.toLowerCase()).filter(Boolean);
}

function hasQuantityStem(name: string): boolean {
  const words = camelWords(name);
  return words.some((word) => QUANTITY_STEMS.has(word) || QUANTITY_STEMS.has(word.replace(/s$/, "")));
}

function isCountOrIndex(name: string): boolean {
  return camelWords(name).some((word) => COUNT_WORDS.has(word));
}

function splitAnnotation(parameterSource: string): { name: string; annotation: string | null } | undefined {
  const trimmed = parameterSource.trim().replace(/^\.\.\./, "");
  const name = /^([A-Za-z_$][\w$]*)/.exec(trimmed)?.[1];
  if (!name) return undefined;
  const afterName = trimmed.slice(name.length).trim();
  if (!/^(\?:|:)/.test(afterName)) return { name, annotation: null };
  const annotation = afterName.replace(/^(\?:|:)/, "").split("=")[0]?.trim() ?? "";
  return { name, annotation: annotation === "" ? null : annotation };
}

function isBareNumber(annotation: string | null): boolean {
  if (annotation === null) return true;
  return /^\s*number(\s*\|\s*(undefined|null))?(\s*\|\s*(undefined|null))?\s*$/.test(annotation);
}

function attachedDocComment(source: string, functionStart: number): string | undefined {
  const before = source.slice(Math.max(0, functionStart - 800), functionStart);
  const matches = [...before.matchAll(/\/\*\*([\s\S]*?)\*\//g)];
  const last = matches.at(-1);
  if (!last || last.index === undefined) return undefined;
  const gap = before.slice(last.index + last[0].length);
  if (!/^\s*(export\s+(default\s+)?)?(async\s+)?$/.test(gap)) return undefined;
  return last[1];
}

function documentsUnit(doc: string | undefined, name: string): boolean {
  if (!doc || !UNIT_WORD.test(doc)) return false;
  const stem = camelWords(name).find((word) => QUANTITY_STEMS.has(word));
  return doc.toLowerCase().includes(name.toLowerCase())
    || (stem !== undefined && doc.toLowerCase().includes(stem));
}

function literalCallerExcerpts(callers: FunctionCaller[]): string[] {
  return callers
    .filter(({ arguments: args }) => args.some((argument) => /^\d/.test(argument.trim())))
    .map(({ call }) => call.slice(0, 160));
}

export function buildUnitAmbiguousQuantityEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnitAmbiguousQuantityEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn: FunctionNode | undefined = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const body = owner.source.slice(fn.start, fn.end);
  if (NAMED_CONVERSION.test(body) || SCALE_OPERATION.test(body)) return undefined;

  const doc = attachedDocComment(owner.source, fn.start);

  const quantities: AmbiguousQuantity[] = [];
  for (const parameter of fn.params) {
    const source = owner.source.slice(parameter.start, parameter.end);
    const split = splitAnnotation(source);
    if (!split || UNIT_SUFFIX.test(split.name)) continue;
    if (!hasQuantityStem(split.name) || isCountOrIndex(split.name)) continue;
    if (!isBareNumber(split.annotation)) continue;
    if (documentsUnit(doc, split.name)) continue;
    quantities.push({
      name: split.name,
      source: source.slice(0, 160),
      annotation: split.annotation,
      literalCallers: [],
    });
  }

  if (quantities.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  const callers = name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [];
  const literals = literalCallerExcerpts(callers);
  for (const quantity of quantities) quantity.literalCallers = literals;

  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    quantities,
    callers,
  };
}
