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

export type TimeUnitLiteral = {
  unit: string;
  excerpt: string;
  line: number;
};

export type HandRolledRelativeTimeEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  units: TimeUnitLiteral[];
  diffSignals: string[];
  copyLiterals: string[];
  usesIntlRelativeTimeFormat: boolean;
  intlRelativeShelf: string[];
  pinnedCopySignals: string[];
  callers: FunctionCaller[];
};

const UNIT_PATTERN = /\b(seconds?|minutes?|hours?|days?|weeks?|months?|years?)\b/i;
const DAY_WORD_PATTERN = /^['"`\s]*(today|yesterday)['"`\s]*$/i;
const DIFF_CONSTANT_PATTERN = /\b(1000|60000|3600000|86400000|604800000)\b/;
const DIFF_IDENTIFIER_PATTERN = /\b(diff|elapsed|deltaMs|ageMs|since|timeAgo)\b/i;
const COPY_PATTERN = /\b(ago|yesterday|just now|last week|last month)\b/i;
const PINNED_PATTERN = /snapshot|toMatchSnapshot|toEqual\(|toStrictEqual\(|toBe\(|copy|brand|voice/i;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function unitIn(text: string): string | undefined {
  const inline = UNIT_PATTERN.exec(text);
  if (inline) return inline[0].toLowerCase();
  const dayWord = DAY_WORD_PATTERN.exec(text);
  if (dayWord?.[1]) return dayWord[1].toLowerCase();
  return undefined;
}

function intlRelativeShelf(projectFiles: ProjectFile[], ownerPath: string): string[] {
  const result: string[] = [];
  for (const file of projectFiles) {
    if (file.filePath === ownerPath) continue;
    if (file.source.includes("Intl.RelativeTimeFormat")) {
      result.push(file.filePath);
      if (result.length >= 8) break;
    }
  }
  return result;
}

export function buildHandRolledRelativeTimeEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HandRolledRelativeTimeEvidence | undefined {
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
  const units: TimeUnitLiteral[] = [];
  const diffSignals: string[] = [];
  const copyLiterals: string[] = [];

  new Visitor({
    Literal(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      const text = owner.source.slice(node.start, node.end);
      const unit = unitIn(text);
      if (unit) {
        units.push({
          unit,
          excerpt: text.slice(0, 200),
          line: lineAt(owner.source, node.start),
        });
      }
      const constant = DIFF_CONSTANT_PATTERN.exec(text);
      if (constant) diffSignals.push(constant[0]);
      const copy = COPY_PATTERN.exec(text);
      if (copy) copyLiterals.push(copy[0]);
    },
    TemplateLiteral(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      const text = owner.source.slice(node.start, node.end);
      const unit = unitIn(text);
      if (unit) {
        units.push({
          unit,
          excerpt: text.slice(0, 200),
          line: lineAt(owner.source, node.start),
        });
      }
      const copy = COPY_PATTERN.exec(text);
      if (copy) copyLiterals.push(copy[0]);
    },
    CallExpression(call) {
      if (call.start < candidate.start || call.end > candidate.end) return;
      if (!belongsDirectlyToFunction(call, nested)) return;
      const callee = owner.source.slice(call.callee.start, call.callee.end);
      if (/Date\s*\.\s*now|getTime$/.test(callee)) {
        diffSignals.push(owner.source.slice(call.start, call.end).slice(0, 120));
      }
    },
  }).visit(parsed.program);

  const distinctUnits = new Set(
    units.map(({ unit }) => unit.replace(/s$/, "")),
  );
  if (distinctUnits.size < 2) return undefined;
  const hasDiff = diffSignals.length > 0 || DIFF_IDENTIFIER_PATTERN.test(candidate.source);
  if (!hasDiff) return undefined;

  const pinnedCopySignals: string[] = [];
  const candidatePin = PINNED_PATTERN.exec(candidate.source);
  if (candidatePin) pinnedCopySignals.push(candidatePin[0].slice(0, 80));
  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);
  for (const caller of callers) {
    const match = PINNED_PATTERN.exec(caller.call);
    if (match) pinnedCopySignals.push(match[0].slice(0, 80));
    if (/test|spec|snapshot/i.test(caller.filePath)) {
      pinnedCopySignals.push(`test-positioned caller: ${caller.filePath}`);
    }
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    units: units.slice(0, 12),
    diffSignals: [...new Set(diffSignals)].slice(0, 8),
    copyLiterals: [...new Set(copyLiterals)].slice(0, 8),
    usesIntlRelativeTimeFormat: candidate.source.includes("Intl.RelativeTimeFormat"),
    intlRelativeShelf: intlRelativeShelf(projectFiles, candidate.filePath),
    pinnedCopySignals: [...new Set(pinnedCopySignals)].slice(0, 8),
    callers,
  };
}
