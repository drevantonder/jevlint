import { parseSync, Visitor } from "oxc-parser";
import type { Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallersWithCoverage,
  functionName,
  isFunctionExported,
  moduleMutableBindings,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

const MAX_DIRECT_CALLERS = 10;
const MAX_REGISTRATION_SITES = 10;
const MAX_EXCERPT_CHARS = 300;

const REGISTRATION_CALL_PATTERN =
  /\b(on|once|addEventListener|addListener|subscribe|register|schedule|setTimeout|setInterval|queueMicrotask)\s*\(/;
const GUARD_PATTERN = /\binProgress\b|\bisRunning\b|\block\w*\b|\bmutex\b|\bdisabled\b|\bdepth\b|\breentr/i;

export type RegistrationSite = {
  filePath: string;
  line: number;
  excerpt: string;
};

export type ReentrantEntryEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  mutatedBindings: string[];
  directCallers: FunctionCaller[];
  directCallerTotal: number;
  registrationSites: RegistrationSite[];
  guardPresent: boolean;
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < source.length && index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assignedModuleBindings(
  program: Parameters<typeof nestedFunctionRanges>[0],
  fn: FunctionNode,
  bindings: Set<string>,
): Set<string> {
  const mutated = new Set<string>();
  const nested = nestedFunctionRanges(program, fn);
  const direct = (node: Node): boolean =>
    fn.start <= node.start && node.end <= fn.end && belongsDirectlyToFunction(node, nested);
  new Visitor({
    AssignmentExpression(node) {
      if (!direct(node)) return;
      if (node.left.type === "Identifier" && bindings.has(node.left.name)) {
        mutated.add(node.left.name);
      }
      if (
        node.left.type === "MemberExpression"
        && node.left.object.type === "Identifier"
        && bindings.has(node.left.object.name)
      ) mutated.add(node.left.object.name);
    },
    UpdateExpression(node) {
      if (!direct(node) || node.argument.type !== "Identifier") return;
      if (bindings.has(node.argument.name)) mutated.add(node.argument.name);
    },
  }).visit(program);
  return mutated;
}

function registrationSites(
  name: string,
  projectFiles: ProjectFile[],
): RegistrationSite[] {
  const pattern = new RegExp(`\\b${escapeRegExp(name)}\\b`);
  const sites: RegistrationSite[] = [];
  for (const file of projectFiles) {
    const lines = file.source.split("\n");
    let offset = 0;
    for (const line of lines) {
      if (pattern.test(line) && REGISTRATION_CALL_PATTERN.test(line)) {
        sites.push({
          filePath: file.filePath,
          line: lineAt(file.source, offset),
          excerpt: line.trim().slice(0, MAX_EXCERPT_CHARS),
        });
        if (sites.length >= MAX_REGISTRATION_SITES) return sites;
      }
      offset += line.length + 1;
    }
  }
  return sites;
}

export function buildReentrantEntryEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ReentrantEntryEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  if (!isFunctionExported(parsed.program, fn, name)) return undefined;

  const bindings = new Set(moduleMutableBindings(parsed.program).map(({ name: binding }) => binding));
  if (bindings.size === 0) return undefined;
  const mutated = assignedModuleBindings(parsed.program, fn, bindings);
  if (mutated.size === 0) return undefined;

  const coverage = findFunctionCallersWithCoverage(candidate.filePath, name, projectFiles);
  const sites = registrationSites(name, projectFiles);
  // Entry-point duality is the proposition: one reachability shape alone
  // leaves nothing for Jev to weigh.
  if (coverage.callers.length === 0 || sites.length === 0) return undefined;

  return {
    function: {
      name,
      exported: true,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    mutatedBindings: [...mutated],
    directCallers: coverage.callers.slice(0, MAX_DIRECT_CALLERS),
    directCallerTotal: coverage.total,
    registrationSites: sites,
    guardPresent: GUARD_PATTERN.test(candidate.source),
  };
}
