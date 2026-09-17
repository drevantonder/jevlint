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
import type { FunctionCaller } from "./repository.js";

export type TelemetryKind = "metric" | "span" | "event";

export type TelemetryEmission = {
  expression: string;
  kind: TelemetryKind;
  name: string;
  line: number;
};

export type TelemetryConsumer = {
  filePath: string;
  excerpt: string;
};

export type UnconsumedTelemetryEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  emissions: TelemetryEmission[];
  consumers: TelemetryConsumer[];
  siblingConsumedCount: number;
  siblingUnconsumedCount: number;
  callers: FunctionCaller[];
};

const EMISSION_CALLEE_PATTERN = /metric|meter|counter|histogram|gauge|tracer|traceSpan|startSpan|statsd|prometheus|datadog|otel|telemetry|analytics\.track|trackEvent/i;
const CONSUMER_FILE_PATTERN = /alert|dashboard|grafana|prometheus|datadog|runbook|monitor|slo|sli/i;
const CONSUMER_CONTENT_PATTERN = /alert|dashboard|panel|runbook|promql|query\(|monitor|slo|sli/i;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function literalName(argument: Expression, source: string): string | undefined {
  if (argument.type !== "Literal") return undefined;
  const raw = source.slice(argument.start, argument.end);
  const quote = raw[0];
  if ((quote === "\"" || quote === "'") && raw.length >= 2 && raw[raw.length - 1] === quote) {
    return raw.slice(1, -1);
  }
  return undefined;
}

function emissionKind(text: string): TelemetryKind {
  if (/traceSpan|startSpan|tracer|span|otel/i.test(text)) return "span";
  if (/analytics\.track|trackEvent|event/i.test(text)) return "event";
  return "metric";
}

export function buildUnconsumedTelemetryEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnconsumedTelemetryEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const inScope = (start: number, end: number): boolean =>
    start >= candidate.start && end <= candidate.end
    && !nested.some((range) => range.start <= start && range.end >= end);

  const emissions: TelemetryEmission[] = [];

  new Visitor({
    CallExpression(call) {
      if (!inScope(call.start, call.end)) return;
      const text = owner.source.slice(call.callee.start, call.callee.end);
      if (text === "console" || text.startsWith("console.")) return;
      if (!EMISSION_CALLEE_PATTERN.test(text)) return;
      const first = call.arguments[0];
      if (!first || first.type === "SpreadElement") return;
      const emissionName = literalName(first, owner.source);
      if (!emissionName) return;
      emissions.push({
        expression: owner.source.slice(call.start, call.end).slice(0, 300),
        kind: emissionKind(text),
        name: emissionName,
        line: lineAt(owner.source, call.start),
      });
    },
  }).visit(parsed.program);

  if (emissions.length === 0) return undefined;

  const names = new Set(emissions.map(({ name: emissionName }) => emissionName));
  const consumers: TelemetryConsumer[] = [];
  for (const file of projectFiles) {
    if (consumers.length >= 6) break;
    if (file.filePath === candidate.filePath) continue;
    const hitsName = [...names].some((emissionName) => file.source.includes(emissionName));
    if (!hitsName) continue;
    if (!CONSUMER_FILE_PATTERN.test(file.filePath) && !CONSUMER_CONTENT_PATTERN.test(file.source)) {
      continue;
    }
    const index = file.source.indexOf([...names].find((emissionName) =>
      file.source.includes(emissionName)
    ) ?? "");
    const lineStart = file.source.lastIndexOf("\n", index) + 1;
    const lineEnd = file.source.indexOf("\n", index);
    consumers.push({
      filePath: file.filePath,
      excerpt: file.source.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim().slice(0, 200),
    });
  }

  let siblingConsumedCount = 0;
  let siblingUnconsumedCount = 0;
  const otherNames = new Set<string>();
  for (const file of projectFiles) {
    const fileParsed = parseSync(file.filePath, file.source, { range: true });
    if (fileParsed.errors.some((error) => error.severity === "Error")) continue;
    new Visitor({
      CallExpression(call) {
        const text = file.source.slice(call.callee.start, call.callee.end);
        if (!EMISSION_CALLEE_PATTERN.test(text)) return;
        const first = call.arguments[0];
        if (!first || first.type === "SpreadElement") return;
        const other = literalName(first, file.source);
        if (other && !names.has(other)) otherNames.add(other);
      },
    }).visit(fileParsed.program);
  }
  for (const other of otherNames) {
    const consumed = projectFiles.some((file) =>
      file.source.includes(other)
      && (CONSUMER_FILE_PATTERN.test(file.filePath) || CONSUMER_CONTENT_PATTERN.test(file.source))
    );
    if (consumed) siblingConsumedCount += 1;
    else siblingUnconsumedCount += 1;
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    emissions,
    consumers,
    siblingConsumedCount,
    siblingUnconsumedCount,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
