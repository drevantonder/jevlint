import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import { functionName, isFunctionExported } from "./repository.js";
import type { FunctionNode } from "./repository.js";
import { isTestFileContent } from "./test-signals.js";

export type ConfessionSignal = {
  signal: string;
  excerpt: string;
};

export type ConfusionConfessingCommentEvidence = {
  comment: {
    filePath: string;
    source: string;
    startLine: number;
  };
  confessionSignals: ConfessionSignal[];
  adjoiningFunction: {
    name: string | null;
    exported: boolean;
    source: string;
  } | null;
  testPinning: { filePath: string; excerpt: string }[];
  trackedWork: string[];
};

const CONFESSION_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "not-sure-why", pattern: /\bnot\s+sure\s+why\b/i },
  { name: "no-idea-why", pattern: /\bno\s+idea\s+why\b/i },
  { name: "dont-know-why", pattern: /\bdon'?t\s+know\s+why\b/i },
  { name: "magic", pattern: /\bmagic\b/i },
  { name: "dont-touch", pattern: /\bdon'?t\s+touch\b/i },
  { name: "dont-ask", pattern: /\bdon'?t\s+ask\b/i },
  { name: "here-be-dragons", pattern: /\bhere\s+be\s+dragons\b/i },
  { name: "seems-to-work", pattern: /\bseems?\s+to\s+work\b/i },
  { name: "works-somehow", pattern: /\bworks?\s+somehow\b/i },
  { name: "no-clue", pattern: /\bno\s+clue\b/i },
  { name: "fragile-unknown", pattern: /\bnobody\s+knows\s+why\b/i },
];

const TRACKED_WORK_PATTERNS: RegExp[] = [
  /#\d+/,
  /\b[A-Z]{2,10}-\d+\b/,
  /https?:\/\/\S+/i,
];

const TEST_POINTER_PATTERNS: RegExp[] = [
  /[\w./-]+\.test\.[\w]+/i,
  /\btest\s+[\w./-]*[A-Za-z_$][\w$]*/i,
  /\bverified\s+by\b/i,
  /\bmeasured\b/i,
  /\bdataset\b/i,
];

function confessionSignals(text: string): ConfessionSignal[] {
  return CONFESSION_PATTERNS.flatMap(({ name, pattern }) => {
    const match = pattern.exec(text);
    return match ? [{ signal: name, excerpt: match[0].slice(0, 200) }] : [];
  });
}

function trackedWork(text: string): string[] {
  const found: string[] = [];
  for (const pattern of TRACKED_WORK_PATTERNS) {
    const match = pattern.exec(text);
    if (match) found.push(match[0].slice(0, 300));
  }
  return found;
}

function namesConcreteVerification(text: string): boolean {
  if (TRACKED_WORK_PATTERNS.some((pattern) => pattern.test(text))) return true;
  return TEST_POINTER_PATTERNS.some((pattern) => pattern.test(text));
}

function adjoiningFunction(
  program: Parameters<Visitor["visit"]>[0],
  candidate: Candidate,
): FunctionNode | undefined {
  const functions: FunctionNode[] = [];
  const collect = (node: FunctionNode): void => {
    if (node.start === candidate.start && node.end === candidate.end) return;
    functions.push(node);
  };
  new Visitor({
    ArrowFunctionExpression: collect,
    FunctionDeclaration: collect,
    FunctionExpression: collect,
  }).visit(program);
  const containers = functions.filter((node) =>
    node.start <= candidate.start && node.end >= candidate.end
  );
  if (containers.length > 0) {
    containers.sort((left, right) => (right.start - left.start) || (right.end - left.end));
    return containers[0];
  }
  const following = functions
    .filter((node) => node.start >= candidate.end)
    .sort((left, right) => left.start - right.start);
  return following[0];
}

function testPinning(
  name: string,
  ownerPath: string,
  projectFiles: ProjectFile[],
): { filePath: string; excerpt: string }[] {
  const reference = new RegExp(`\\b${name.replaceAll(/[^A-Za-z0-9_$]/g, "")}\\b`);
  const pinned: { filePath: string; excerpt: string }[] = [];
  for (const file of projectFiles) {
    if (file.filePath === ownerPath) continue;
    if (!isTestFileContent(file.filePath, file.source)) continue;
    for (const line of file.source.split("\n")) {
      if (!reference.test(line)) continue;
      pinned.push({ filePath: file.filePath, excerpt: line.trim().slice(0, 300) });
      if (pinned.length >= 5) return pinned;
    }
  }
  return pinned;
}

export function buildConfusionConfessingCommentEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ConfusionConfessingCommentEvidence | undefined {
  if (candidate.kind !== "comment") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;

  const signals = confessionSignals(candidate.source);
  if (signals.length === 0) return undefined;
  if (namesConcreteVerification(candidate.source)) return undefined;

  const fn = adjoiningFunction(parsed.program, candidate);
  const name = fn ? functionName(parsed.program, fn) : undefined;
  return {
    comment: {
      filePath: candidate.filePath,
      source: candidate.source,
      startLine: candidate.startLine,
    },
    confessionSignals: signals,
    adjoiningFunction: fn
      ? {
        name: name ?? null,
        exported: name ? isFunctionExported(parsed.program, fn, name) : false,
        source: ownerFile.source.slice(fn.start, fn.end).slice(0, 4000),
      }
      : null,
    testPinning: name ? testPinning(name, candidate.filePath, projectFiles) : [],
    trackedWork: trackedWork(candidate.source),
  };
}
