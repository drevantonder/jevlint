import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  calleeRootName,
  isInsideNestedFunction,
  nestedFunctionRanges,
} from "./repository.js";
import { parseTestFunction } from "./test-scope.js";
import { isTestFileContent } from "./test-signals.js";

export type SleepCallEvidence = {
  expression: string;
  kind: "sleep" | "setTimeout" | "waitForTimeout" | "delay";
  durationMs: number | null;
};

export type SleepInTestEvidence = {
  function: {
    title: string | null;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  sleepCalls: SleepCallEvidence[];
  pollingHelpers: string[];
  maybeDurationSubject: boolean;
  repository: {
    pollingHelperFiles: string[];
  };
};

function callText(call: CallExpression, source: string): string {
  return source.slice(call.start, call.end);
}

function sleepKind(call: CallExpression, source: string): SleepCallEvidence["kind"] | null {
  const text = callText(call, source);
  if (/\bwaitForTimeout\s*\(/.test(text)) return "waitForTimeout";
  const root = calleeRootName(call.callee);
  if (root === "setTimeout") return "setTimeout";
  if (root === "sleep" || root === "delay") return root;
  return null;
}

function durationMs(call: CallExpression, source: string): number | null {
  const text = callText(call, source);
  const match = /\(\s*(\d[\d_]*)/.exec(text);
  if (!match?.[1]) return null;
  return Number(match[1].replaceAll("_", ""));
}

function isPollingHelper(call: CallExpression, source: string): boolean {
  const text = callText(call, source);
  if (/\bwaitForTimeout\s*\(/.test(text)) return false;
  return /\b(waitFor|waitUntil|eventually|poll|retryUntil|waitForExpect|waitForAssertion)\b/.test(text);
}

function pollingHelperFiles(ownerPath: string, projectFiles: ProjectFile[]): string[] {
  const files: string[] = [];
  for (const file of projectFiles) {
    if (file.filePath === ownerPath || !isTestFileContent(file.filePath, file.source)) continue;
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    let found = false;
    new Visitor({
      CallExpression(call) {
        if (found) return;
        if (isPollingHelper(call, file.source)) found = true;
      },
    }).visit(parsed.program);
    if (found) files.push(file.filePath);
  }
  return files;
}

export function buildSleepInTestEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): SleepInTestEvidence | undefined {
  const scope = parseTestFunction(candidate, projectFiles);
  if (!scope) return undefined;
  if (scope.runner !== "it" && scope.runner !== "test") return undefined;
  const { owner, program, fn } = scope;
  const nested = nestedFunctionRanges(program, candidate);

  const sleepCalls: SleepCallEvidence[] = [];
  const pollingHelpers: string[] = [];
  let maybeDurationSubject = false;
  const seen = new Set<number>();
  new Visitor({
    CallExpression(call) {
      if (call.start < fn.start || call.end > fn.end) return;
      if (isInsideNestedFunction(call, nested)) return;
      const kind = sleepKind(call, owner.source);
      if (kind && !seen.has(call.start)) {
        seen.add(call.start);
        sleepCalls.push({
          expression: callText(call, owner.source),
          kind,
          durationMs: durationMs(call, owner.source),
        });
        return;
      }
      if (isPollingHelper(call, owner.source)) {
        pollingHelpers.push(callText(call, owner.source));
        return;
      }
      const text = callText(call, owner.source);
      if (/debounce|throttle|duration|interval/i.test(text)) maybeDurationSubject = true;
    },
  }).visit(program);

  if (sleepCalls.length === 0) return undefined;
  return {
    function: {
      title: scope.title,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    sleepCalls,
    pollingHelpers: pollingHelpers.slice(0, 10),
    maybeDurationSubject,
    repository: {
      pollingHelperFiles: pollingHelperFiles(owner.filePath, projectFiles),
    },
  };
}
