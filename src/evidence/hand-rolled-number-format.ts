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

export type HandRolledNumberFormatEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  techniques: string[];
  currencySymbols: string[];
  toFixedCalls: string[];
  separatorRegexes: string[];
  usesIntlNumberFormat: boolean;
  intlNumberShelf: string[];
  pinnedOutputSignals: string[];
  callers: FunctionCaller[];
};

const CURRENCY_PATTERN = /[$€£¥₹]/;
const SEPARATOR_REGEX_HINT = /\\B|\\d\{3\}|\(\?=/;
const ASSEMBLY_PATTERN = /\+=|\.join\(|`[^`]*\$\{|"[^"]*"\s*\+|\+\s*"[^"]*"/;
const PINNED_PATTERN = /snapshot|toMatchSnapshot|toEqual\(|toStrictEqual\(|toBe\(|parser|wire|serializ|contract/i;

function intlNumberShelf(projectFiles: ProjectFile[], ownerPath: string): string[] {
  const result: string[] = [];
  for (const file of projectFiles) {
    if (file.filePath === ownerPath) continue;
    if (file.source.includes("Intl.NumberFormat")) {
      result.push(file.filePath);
      if (result.length >= 8) break;
    }
  }
  return result;
}

export function buildHandRolledNumberFormatEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HandRolledNumberFormatEvidence | undefined {
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
  const toFixedCalls: string[] = [];
  const separatorRegexes: string[] = [];
  const currencySymbols = new Set<string>();

  new Visitor({
    CallExpression(call) {
      if (call.start < candidate.start || call.end > candidate.end) return;
      if (!belongsDirectlyToFunction(call, nested)) return;
      const callee = owner.source.slice(call.callee.start, call.callee.end);
      if (callee.endsWith(".toFixed") || callee === "toFixed") {
        toFixedCalls.push(owner.source.slice(call.start, call.end).slice(0, 200));
      }
      if (callee.endsWith(".replace") || callee === "replace") {
        const first = call.arguments[0];
        if (!first) return;
        const pattern = owner.source.slice(first.start, first.end);
        if (pattern.startsWith("/") && SEPARATOR_REGEX_HINT.test(pattern)) {
          separatorRegexes.push(owner.source.slice(call.start, call.end).slice(0, 200));
        }
      }
    },
    Literal(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      const text = owner.source.slice(node.start, node.end);
      const symbol = CURRENCY_PATTERN.exec(text);
      if (symbol) currencySymbols.add(symbol[0]);
    },
    TemplateLiteral(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      const text = owner.source.slice(node.start, node.end);
      const symbol = CURRENCY_PATTERN.exec(text);
      if (symbol) currencySymbols.add(symbol[0]);
    },
  }).visit(parsed.program);

  const assembled = ASSEMBLY_PATTERN.test(candidate.source);
  const techniques: string[] = [];
  if (separatorRegexes.length > 0) techniques.push("thousand-separator-regex");
  if (toFixedCalls.length > 0 && assembled) techniques.push("toFixed-post-processing");
  if (currencySymbols.size > 0 && assembled) techniques.push("manual-currency-prefix");
  if (techniques.length === 0) return undefined;

  const pinnedOutputSignals: string[] = [];
  const candidatePin = PINNED_PATTERN.exec(candidate.source);
  if (candidatePin) pinnedOutputSignals.push(candidatePin[0].slice(0, 80));
  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);
  for (const caller of callers) {
    const match = PINNED_PATTERN.exec(caller.call);
    if (match) pinnedOutputSignals.push(match[0].slice(0, 80));
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    techniques,
    currencySymbols: [...currencySymbols],
    toFixedCalls: toFixedCalls.slice(0, 8),
    separatorRegexes: separatorRegexes.slice(0, 8),
    usesIntlNumberFormat: candidate.source.includes("Intl.NumberFormat"),
    intlNumberShelf: intlNumberShelf(projectFiles, candidate.filePath),
    pinnedOutputSignals: [...new Set(pinnedOutputSignals)].slice(0, 8),
    callers,
  };
}