import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { calleeRootName, findDirectFunction, findFunctionCallersWithCoverage, findSeamCallSites } from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";
import { isTestFilename, isTestProjectFile } from "./test-signals.js";

export interface TestFunctionScope {
  owner: ProjectFile;
  program: Program;
  fn: FunctionNode;
  title: string | null;
  runner: "it" | "test" | "describe" | null;
}

export function isTestFilePath(filePath: string, projectFiles?: ProjectFile[]): boolean {
  if (projectFiles !== undefined) return isTestProjectFile(filePath, projectFiles);
  return isTestFilename(filePath);
}

export interface PartitionedCallers {
  production: FunctionCaller[];
  test: FunctionCaller[];
}

/** Split callers into production callers and test callers.
 * A test caller exercises the function without making it live in the product,
 * so rules count only production callers while naming test callers as evidence. */
export function partitionCallersByTest(
  callers: FunctionCaller[],
  projectFiles?: ProjectFile[],
): PartitionedCallers {
  const production: FunctionCaller[] = [];
  const test: FunctionCaller[] = [];
  for (const caller of callers) {
    if (isTestFilePath(caller.filePath, projectFiles)) test.push(caller);
    else production.push(caller);
  }
  return { production, test };
}

/** One hop of transitive test pinning: a test exercises a public seam that
 * calls the candidate, so the candidate is pinned even though no test names
 * it directly. The walk stops after one hop — two-hop chains (test → S1 →
 * S2 → candidate) explode combinatorially and blur pinning attribution, so
 * only test → seam → candidate chains are reported. Pinning informs, never
 * silences: chains are evidence facts for Jev to weigh, with no change to
 * abstention semantics. */
export type TransitivePin = {
  /** Test file exercising the seam. */
  test: string;
  /** Seam the test calls. */
  seam: string;
  /** Module owning the seam. */
  seamFile: string;
  /** The seam call observed in the test, truncated for evidence. */
  seamCall: string;
  /** Candidate the seam reaches. */
  candidate: string;
};

const TRANSITIVE_PIN_LIMIT = 10;
const TRANSITIVE_SEAM_CALL_CHARS = 240;

export function findTransitiveTestPins(
  ownerPath: string,
  candidateName: string,
  projectFiles: ProjectFile[],
): TransitivePin[] {
  const pins: TransitivePin[] = [];
  const seen = new Set<string>();
  for (const site of findSeamCallSites(ownerPath, candidateName, projectFiles)) {
    if (site.seam === null) continue;
    if (isTestFilePath(site.filePath, projectFiles)) continue;
    if (site.filePath === ownerPath && site.seam === candidateName) continue;
    const seamCallers = findFunctionCallersWithCoverage(site.filePath, site.seam, projectFiles);
    for (const caller of seamCallers.callers) {
      if (!isTestFilePath(caller.filePath, projectFiles)) continue;
      const key = `${caller.filePath}\u0000${site.filePath}\u0000${site.seam}`;
      if (seen.has(key)) continue;
      seen.add(key);
      pins.push({
        test: caller.filePath,
        seam: site.seam,
        seamFile: site.filePath,
        seamCall: caller.call.slice(0, TRANSITIVE_SEAM_CALL_CHARS),
        candidate: candidateName,
      });
    }
  }
  pins.sort((left, right) =>
    left.test.localeCompare(right.test)
    || left.seamFile.localeCompare(right.seamFile)
    || left.seam.localeCompare(right.seam)
  );
  return pins.slice(0, TRANSITIVE_PIN_LIMIT);
}

export function parseTestFunction(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): TestFunctionScope | undefined {
  if (candidate.kind !== "function") return undefined;
  if (!isTestFilePath(candidate.filePath, projectFiles)) return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const holder = enclosingHolder(parsed.program, fn, owner.source);
  return {
    owner,
    program: parsed.program,
    fn,
    title: holder?.title ?? null,
    runner: holder?.runner ?? null,
  };
}

const TEST_RUNNERS = new Set(["describe", "it", "test"]);

function runnerRoot(callee: CallExpression["callee"]): string | null {
  if (callee.type === "CallExpression") return runnerRoot(callee.callee);
  return calleeRootName(callee);
}

function quotedInner(raw: string): string | null {
  const quote = raw[0];
  if (quote !== "\"" && quote !== "'" && quote !== "`") return null;
  if (raw.length < 2 || raw[raw.length - 1] !== quote) return null;
  if (quote === "`" && raw.includes("${")) return null;
  return raw.slice(1, -1);
}

function enclosingHolder(
  program: Program,
  fn: FunctionNode,
  source: string,
): { title: string | null; runner: "it" | "test" | "describe" | null } | undefined {
  let holder: { title: string | null; runner: "it" | "test" | "describe" | null } | undefined;
  new Visitor({
    CallExpression(call) {
      if (call.start > fn.start || call.end < fn.end) return;
      const root = runnerRoot(call.callee);
      if (!root || !TEST_RUNNERS.has(root)) return;
      const holds = call.arguments.some((argument) => {
        if (argument.type === "SpreadElement") return false;
        const value = argument.type === "ChainExpression" ? argument.expression : argument;
        return (
          (value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression")
          && value.start === fn.start
          && value.end === fn.end
        );
      });
      if (!holds) return;
      const first = call.arguments[0];
      const title = !first || first.type === "SpreadElement" || first.type !== "Literal"
        ? null
        : quotedInner(source.slice(first.start, first.end));
      const runner = root === "it" || root === "test" || root === "describe" ? root : null;
      holder = { title, runner };
    },
  }).visit(program);
  return holder;
}
