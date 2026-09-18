import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type IdAssemblyCall = {
  call: string;
  line: number;
};

export type HandRolledUuidEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  idKind: "uuid-template" | "hex-assembly" | "base36-short";
  randomCalls: IdAssemblyCall[];
  assemblySignals: string[];
  hasFixedPrefix: boolean;
  randomUuidInScope: boolean;
  callers: FunctionCaller[];
};

const UUID_TEMPLATE_PATTERN = /x{4,}|\[xy\]|\[XY\]/;
const HEX_ASSEMBLY_PATTERN = /toString\(\s*16/;
const BASE36_ASSEMBLY_PATTERN = /toString\(\s*36/;
const ASSEMBLY_SIGNAL_PATTERN = /slice|substring|padStart|join\(\s*["']-["']/;
const PREFIX_CONCAT_PATTERN = /["'][A-Za-z]{2,}[-_#]["']\s*\+/;
const SECURITY_POSITION_PATTERN = /token|session|secret|password|reset|auth|otp|nonce|api[_-]?key|client[_-]?secret/i;
const RANDOM_UUID_PATTERN = /randomUUID/;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function isMathRandomCall(call: CallExpression): boolean {
  return call.callee.type === "MemberExpression"
    && call.callee.object.type === "Identifier"
    && call.callee.object.name === "Math"
    && call.callee.property.type === "Identifier"
    && call.callee.property.name === "random";
}

function classifyIdKind(source: string): HandRolledUuidEvidence["idKind"] | undefined {
  if (UUID_TEMPLATE_PATTERN.test(source)) return "uuid-template";
  if (HEX_ASSEMBLY_PATTERN.test(source)) return "hex-assembly";
  if (BASE36_ASSEMBLY_PATTERN.test(source) && ASSEMBLY_SIGNAL_PATTERN.test(source)) {
    return "base36-short";
  }
  return undefined;
}

export function buildHandRolledUuidEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HandRolledUuidEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const idKind = classifyIdKind(candidate.source);
  if (!idKind) return undefined;

  const randomCalls: IdAssemblyCall[] = [];
  // The assembly callback (String.replace, Array.from) is a nested closure that
  // is part of the mechanism itself, so every call in the candidate range counts.
  new Visitor({
    CallExpression(call) {
      if (!isMathRandomCall(call)) return;
      if (call.start < candidate.start || call.end > candidate.end) return;
      randomCalls.push({
        call: owner.source.slice(call.start, call.end),
        line: lineAt(owner.source, call.start),
      });
    },
  }).visit(parsed.program);
  if (randomCalls.length === 0) return undefined;

  // Token strength in an adversary-facing position belongs to
  // jev/no-predictable-token; this rule scores reuse for ordinary ids.
  if (SECURITY_POSITION_PATTERN.test(name)) return undefined;
  if (SECURITY_POSITION_PATTERN.test(candidate.source)) return undefined;

  const assemblySignals = new Set<string>();
  for (const pattern of [UUID_TEMPLATE_PATTERN, HEX_ASSEMBLY_PATTERN, BASE36_ASSEMBLY_PATTERN, ASSEMBLY_SIGNAL_PATTERN]) {
    const match = pattern.exec(candidate.source);
    if (match) assemblySignals.add(match[0].slice(0, 40));
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    idKind,
    randomCalls: randomCalls.slice(0, 10),
    assemblySignals: [...assemblySignals],
    hasFixedPrefix: PREFIX_CONCAT_PATTERN.test(candidate.source),
    randomUuidInScope: RANDOM_UUID_PATTERN.test(owner.source),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
