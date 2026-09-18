import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { calleeRootName, findDirectFunction } from "./repository.js";
import type { FunctionNode } from "./repository.js";

export interface TestFunctionScope {
  owner: ProjectFile;
  program: Program;
  fn: FunctionNode;
  title: string | null;
  runner: "it" | "test" | "describe" | null;
}

export function isTestFilePath(filePath: string): boolean {
  const normalized = filePath.replaceAll("\\", "/");
  const base = normalized.split("/").pop() ?? normalized;
  if (/(^|\.)(test|spec)\.[cm]?[jt]sx?$/i.test(base)) return true;
  return /(^|\/)__tests__\//.test(normalized);
}

export function parseTestFunction(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): TestFunctionScope | undefined {
  if (candidate.kind !== "function") return undefined;
  if (!isTestFilePath(candidate.filePath)) return undefined;
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
