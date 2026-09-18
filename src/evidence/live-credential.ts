import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, nestedFunctionRanges } from "./function-scope.js";
import { isTestProjectFile } from "./test-signals.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type LiveCredential = {
  binding: string;
  line: number;
  length: number;
  staged: "assignment" | "argument";
  placeholder: boolean;
  entropyBitsPerChar: number;
  preview: string;
};

export type ClientUse = {
  call: string;
  line: number;
};

export type LiveCredentialEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    fileRole: "test" | "docs" | "service";
    source: string;
  };
  secrets: LiveCredential[];
  reachesClient: ClientUse[];
  envPlumbing: string[];
  callers: FunctionCaller[];
};

const CREDENTIAL_NAME_PATTERN = /password|passwd|secret|token|api[_-]?key|auth|private[_-]?key|client[_-]?secret|access[_-]?key|bearer/i;
const PLACEHOLDER_PATTERN = /example|changeme|xxx+|test|dummy|placeholder|localhost|1234|password|qwerty|asdf|abcd/i;
const CLIENT_CALL_PATTERN = /client|connect|login|auth|token|secret|password|stripe|openai|sendgrid|twilio|aws|redis|postgres|mongo/i;
const ENV_PATTERN = /process\.env\.([A-Za-z_][\w]*)/g;
const DOCS_PATH_PATTERN = /(^|\/)(docs|examples?)(^|\/)/i;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function entropyBitsPerChar(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return Math.round(entropy * 100) / 100;
}

function previewOf(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 2)}…(${value.length})`;
  return `${value.slice(0, 2)}…${value.slice(-1)}(${value.length})`;
}

function stringValue(node: Expression, source: string): string | undefined {
  if (node.type === "LogicalExpression") {
    return stringValue(node.left, source) ?? stringValue(node.right, source);
  }
  if (node.type === "TemplateLiteral" && node.expressions.length > 0) return undefined;
  const raw = source.slice(node.start, node.end);
  const quote = raw[0];
  if (quote !== "\"" && quote !== "'" && quote !== "`") return undefined;
  if (raw.length < 2 || raw[raw.length - 1] !== quote) return undefined;
  const inner = raw.slice(1, -1);
  return inner.length === 0 ? undefined : inner;
}

function fileRole(filePath: string, projectFiles: ProjectFile[]): "test" | "docs" | "service" {
  if (isTestProjectFile(filePath, projectFiles)) return "test";
  if (DOCS_PATH_PATTERN.test(filePath)) return "docs";
  return "service";
}

export function buildLiveCredentialEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): LiveCredentialEvidence | undefined {
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
  const direct = (node: { start: number; end: number }): boolean =>
    node.start >= candidate.start && node.end <= candidate.end
    && belongsDirectlyToFunction(node, nested);

  const secrets: LiveCredential[] = [];
  const bindings = new Set<string>();
  const record = (binding: string, line: number, value: string, staged: LiveCredential["staged"]): void => {
    bindings.add(binding);
    secrets.push({
      binding,
      line,
      length: value.length,
      staged,
      placeholder: PLACEHOLDER_PATTERN.test(value) || PLACEHOLDER_PATTERN.test(binding),
      entropyBitsPerChar: entropyBitsPerChar(value),
      preview: previewOf(value),
    });
  };
  new Visitor({
    VariableDeclarator(node) {
      if (!node.init || !direct(node)) return;
      if (node.id.type !== "Identifier" || !CREDENTIAL_NAME_PATTERN.test(node.id.name)) return;
      const value = stringValue(node.init, owner.source);
      if (value === undefined || value.length === 0) return;
      record(node.id.name, lineAt(owner.source, node.start), value, "assignment");
    },
    AssignmentExpression(node) {
      if (!direct(node)) return;
      if (node.left.type !== "Identifier" || !CREDENTIAL_NAME_PATTERN.test(node.left.name)) return;
      const value = stringValue(node.right, owner.source);
      if (value === undefined || value.length === 0) return;
      record(node.left.name, lineAt(owner.source, node.start), value, "assignment");
    },
    CallExpression(call) {
      if (!direct(call)) return;
      const callee = owner.source.slice(call.callee.start, call.callee.end);
      for (const argument of call.arguments) {
        if (argument.type === "SpreadElement") continue;
        const value = stringValue(argument, owner.source);
        if (value === undefined || value.length < 8) continue;
        if (!CREDENTIAL_NAME_PATTERN.test(callee) && !CLIENT_CALL_PATTERN.test(callee)) continue;
        record(`${callee}()`, lineAt(owner.source, argument.start), value, "argument");
      }
    },
  }).visit(parsed.program);
  if (secrets.length === 0) return undefined;

  const reachesClient: ClientUse[] = [];
  new Visitor({
    CallExpression(call) {
      if (!direct(call)) return;
      const text = owner.source.slice(call.start, call.end);
      if (![...bindings].some((binding) => new RegExp(`\\b${binding.replace(/[^\w$]/g, "")}\\b`).test(text))) {
        return;
      }
      if (call.callee.type === "Identifier" && bindings.has(call.callee.name)) return;
      reachesClient.push({
        call: text.slice(0, 200),
        line: lineAt(owner.source, call.start),
      });
    },
    NewExpression(call) {
      if (!direct(call)) return;
      const text = owner.source.slice(call.start, call.end);
      if (![...bindings].some((binding) => new RegExp(`\\b${binding.replace(/[^\w$]/g, "")}\\b`).test(text))) {
        return;
      }
      reachesClient.push({
        call: text.slice(0, 200),
        line: lineAt(owner.source, call.start),
      });
    },
  }).visit(parsed.program);

  const envPlumbing = [...owner.source.matchAll(ENV_PATTERN)]
    .map((match) => match[1])
    .filter((key): key is string => key !== undefined)
    .filter((key, index, all) => all.indexOf(key) === index)
    .slice(0, 10);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      fileRole: fileRole(candidate.filePath, projectFiles),
      source: candidate.source,
    },
    secrets: secrets.slice(0, 10),
    reachesClient: reachesClient.slice(0, 10),
    envPlumbing,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
