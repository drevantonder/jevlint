import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";

export type FlagLifecycle = {
  owner: string | null;
  ticket: string | null;
  expiry: string | null;
};

export type NewFlagGate = {
  filePath: string;
  expression: string;
  flagName: string;
  line: number;
  lifecycle: FlagLifecycle;
};

export type UnownedFeatureFlagEvidence = {
  anchorFile: string;
  coverage: {
    totalFiles: number;
    comparedFiles: number;
  };
  newGates: NewFlagGate[];
  siblingFlagsWithLifecycle: number;
  siblingFlagsWithoutLifecycle: number;
};

const FLAG_GATE_PATTERN = /flags?\.\w+|isEnabled\s*\(|isFeatureEnabled\s*\(|hasFlag\s*\(|useFlag\s*\(|useFeatureFlag\s*\(|experiments?\.\w+|toggles?\.\w+|features?\.\w+|LaunchDarkly|ldClient/i;
const FLAG_NAME_PATTERN = /(?:flags?|experiments?|toggles?|features?)\.([A-Za-z_$][\w$]*)|(?:isEnabled|isFeatureEnabled|hasFlag|useFlag|useFeatureFlag)\s*\(\s*["'`]([^"'`]+)["'`]/;
const OWNER_PATTERN = /@owner\b|owner\s*[:=]\s*["']?[\w.@-]+|owned-by|codeowner/i;
const TICKET_PATTERN = /#[0-9]+|https?:\/\/\S*(?:jira|linear|github\.com\/\S+\/(?:issues|pull)|atlassian)[^\s"']*|[A-Z]{2,}-[0-9]+|ticket\s*[:=]|issue\s*[:=]/i;
const EXPIRY_PATTERN = /expir|removeAfter|remove-by|removeBy|sunset|kill-date|revisit|TODO.*20[2-9][0-9]|20[2-9][0-9]-[0-9]{2}-[0-9]{2}/i;
const MAX_GATES = 10;

function changedLineSet(change: SourceFile): Set<number> {
  const lines = new Set<number>();
  for (const range of change.changedLines) {
    for (let line = range.start; line <= range.end; line += 1) lines.add(line);
  }
  return lines;
}

function lifecycleAround(source: string, offset: number): FlagLifecycle {
  const windowStart = Math.max(0, offset - 600);
  const windowEnd = Math.min(source.length, offset + 200);
  const window = source.slice(windowStart, windowEnd);
  const owner = OWNER_PATTERN.exec(window)?.[0].slice(0, 120) ?? null;
  const ticket = TICKET_PATTERN.exec(window)?.[0].slice(0, 200) ?? null;
  const expiry = EXPIRY_PATTERN.exec(window)?.[0].slice(0, 120) ?? null;
  return { owner, ticket, expiry };
}

function flagNameOf(text: string): string | undefined {
  const match = FLAG_NAME_PATTERN.exec(text);
  return match?.[1] ?? match?.[2];
}

function gateExpressions(program: ReturnType<typeof parseCached>["program"], source: string): string[] {
  const gates: string[] = [];
  new Visitor({
    IfStatement(node) {
      const text = source.slice(node.test.start, node.test.end);
      if (FLAG_GATE_PATTERN.test(text)) gates.push(text);
    },
    ConditionalExpression(node) {
      const text = source.slice(node.test.start, node.test.end);
      if (FLAG_GATE_PATTERN.test(text)) gates.push(text);
    },
    LogicalExpression(node) {
      const text = source.slice(node.start, node.end);
      if (FLAG_GATE_PATTERN.test(text) && text.length < 300) gates.push(text);
    },
  }).visit(program);
  return gates;
}

function gateLine(source: string, gate: string, changed: Set<number>): number | null {
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!changed.has(index + 1)) continue;
    if (lines[index]?.includes(gate.slice(0, 40))) return index + 1;
  }
  return null;
}

export function buildUnownedFeatureFlagEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): UnownedFeatureFlagEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  const newGates: NewFlagGate[] = [];
  let compared = 0;

  for (const change of changes) {
    if (newGates.length >= MAX_GATES) break;
    const afterParsed = parseCached(change.filePath, change.source);
    if (afterParsed.errors.some((error) => error.severity === "Error")) continue;
    compared += 1;
    const changed = changedLineSet(change);
    const afterGates = gateExpressions(afterParsed.program, change.source);
    if (afterGates.length === 0) continue;
    const beforeGates = new Set<string>();
    if (change.oldSource !== null) {
      const beforeParsed = parseCached(change.filePath, change.oldSource);
      if (!beforeParsed.errors.some((error) => error.severity === "Error")) {
        for (const gate of gateExpressions(beforeParsed.program, change.oldSource)) {
          beforeGates.add(gate);
        }
      }
    }
    for (const gate of afterGates) {
      if (newGates.length >= MAX_GATES) break;
      if (beforeGates.has(gate)) continue;
      const line = gateLine(change.source, gate, changed);
      if (line === null) continue;
      const gateOffset = change.source.split("\n").slice(0, line - 1).join("\n").length + 1;
      newGates.push({
        filePath: change.filePath,
        expression: gate.slice(0, 200),
        flagName: flagNameOf(gate) ?? gate.slice(0, 60),
        line,
        lifecycle: lifecycleAround(change.source, gateOffset),
      });
    }
  }

  if (newGates.length === 0) return undefined;

  let siblingFlagsWithLifecycle = 0;
  let siblingFlagsWithoutLifecycle = 0;
  const newNames = new Set(newGates.map(({ flagName }) => flagName));
  for (const file of projectFiles) {
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const gates = gateExpressions(parsed.program, file.source);
    for (const gate of gates) {
      const name = flagNameOf(gate);
      if (name && newNames.has(name)) continue;
      const offset = file.source.indexOf(gate);
      const lifecycle = lifecycleAround(file.source, offset < 0 ? 0 : offset);
      if (lifecycle.owner || lifecycle.ticket || lifecycle.expiry) siblingFlagsWithLifecycle += 1;
      else siblingFlagsWithoutLifecycle += 1;
    }
  }

  if (siblingFlagsWithLifecycle + siblingFlagsWithoutLifecycle === 0) return undefined;

  return {
    anchorFile: candidate.filePath,
    coverage: { totalFiles: changes.length, comparedFiles: compared },
    newGates,
    siblingFlagsWithLifecycle,
    siblingFlagsWithoutLifecycle,
  };
}
