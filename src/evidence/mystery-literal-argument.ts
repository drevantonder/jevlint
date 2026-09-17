import { parseSync, Visitor } from "oxc-parser";
import type { CallExpression, Program } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import {
  calleeRootName,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type { FunctionNode } from "./repository.js";

export type MysteryLiteralCallSite = {
  filePath: string;
  line: number;
  call: string;
  callee: string;
  argumentIndex: number;
  parameterName: string;
  parameterType: string | null;
  literal: string;
  literalKind: "string" | "number" | "boolean";
  conventional: boolean;
  calleeBranchesOnParameter: boolean;
  calleeComparesParameterToLiteral: boolean;
  branchExcerpts: string[];
};

export type MysteryLiteralArgumentEvidence = {
  anchorFile: string;
  coverage: {
    totalFiles: number;
    includedFiles: number;
    includedFilePaths: string[];
  };
  callSites: MysteryLiteralCallSite[];
};

const MAX_SITES = 10;
const MAX_EXCERPT_CHARS = 300;

const CONVENTIONAL_STRINGS = new Set([
  "utf-8",
  "utf8",
  "utf-16",
  "ascii",
  "base64",
  "base64url",
  "hex",
  "latin1",
  "json",
]);

const SKIPPED_CALLEES = new Set([
  "describe",
  "it",
  "test",
  "expect",
  "beforeEach",
  "afterEach",
  "afterAll",
  "beforeAll",
  "console",
  "require",
]);

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function lineInRanges(line: number, ranges: { start: number; end: number }[]): boolean {
  return ranges.some(({ start, end }) => line >= start && line <= end);
}

function literalKind(raw: string | null): "string" | "number" | "boolean" | null {
  if (raw === null || raw === "") return null;
  if (raw === "null") return null;
  const first = raw[0];
  if (first === "\"" || first === "'" || first === "`") return "string";
  if (raw === "true" || raw === "false") return "boolean";
  if (/^[0-9.]/.test(raw)) return "number";
  return null;
}

function literalValue(raw: string): string {
  const first = raw[0];
  const last = raw[raw.length - 1];
  if ((first === "\"" || first === "'" || first === "`") && last === first) {
    return raw.slice(1, -1);
  }
  return raw;
}

function findNamedFunction(program: Program, name: string): FunctionNode | undefined {
  let result: FunctionNode | undefined;
  new Visitor({
    FunctionDeclaration(node) {
      if (!result && node.id?.name === name) result = node;
    },
    VariableDeclarator(node) {
      if (!result
        && node.id.type === "Identifier"
        && node.id.name === name
        && node.init
        && (node.init.type === "ArrowFunctionExpression" || node.init.type === "FunctionExpression")) {
        result = node.init;
      }
    },
  }).visit(program);
  return result;
}

function bindingName(parameter: FunctionNode["params"][number]): string | undefined {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  if (value.type === "Identifier") return value.name;
  if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
    return value.left.name;
  }
  return undefined;
}

type ResolvedCallee = {
  file: ProjectFile;
  program: Program;
  fn: FunctionNode;
};

function resolveCallee(
  callee: string,
  callerPath: string,
  callerProgram: Program,
  projectFiles: ProjectFile[],
): ResolvedCallee | undefined {
  const local = findNamedFunction(callerProgram, callee);
  if (local) {
    const owner = projectFiles.find((file) => file.filePath === callerPath);
    if (owner) {
      const parsed = parseSync(owner.filePath, owner.source, { range: true });
      if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
      const fn = findNamedFunction(parsed.program, callee);
      if (fn) return { file: owner, program: parsed.program, fn };
    }
  }
  const imported = moduleImports(callerProgram).find(({ local: localName }) => localName === callee);
  if (!imported || !imported.source.startsWith(".")) return undefined;
  const target = resolveModule(callerPath, imported.source, projectFiles);
  if (!target) return undefined;
  const parsed = parseSync(target.filePath, target.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findNamedFunction(parsed.program, imported.imported === "default" ? callee : imported.imported);
  if (!fn) return undefined;
  return { file: target, program: parsed.program, fn };
}

type CalleeSelection = {
  branchesOnParameter: boolean;
  comparesParameterToLiteral: boolean;
  branchExcerpts: string[];
};

function inspectCallee(source: string, resolved: ResolvedCallee, parameterName: string): CalleeSelection {
  const branchExcerpts: string[] = [];
  let branchesOnParameter = false;
  let comparesParameterToLiteral = false;
  const reference = new RegExp(`\\b${parameterName}\\b`);
  const inside = (node: { start: number; end: number }): boolean =>
    node.start >= resolved.fn.start && node.end <= resolved.fn.end;
  const pushExcerpt = (start: number, end: number): void => {
    if (branchExcerpts.length >= 5) return;
    branchExcerpts.push(source.slice(start, end).slice(0, MAX_EXCERPT_CHARS));
  };
  new Visitor({
    IfStatement(node) {
      if (!inside(node) || !reference.test(source.slice(node.test.start, node.test.end))) return;
      branchesOnParameter = true;
      pushExcerpt(node.start, node.end);
    },
    ConditionalExpression(node) {
      if (!inside(node) || !reference.test(source.slice(node.test.start, node.test.end))) return;
      branchesOnParameter = true;
      pushExcerpt(node.start, node.end);
    },
    SwitchStatement(node) {
      if (!inside(node) || !reference.test(source.slice(node.discriminant.start, node.discriminant.end))) {
        return;
      }
      branchesOnParameter = true;
      pushExcerpt(node.start, node.end);
    },
    BinaryExpression(node) {
      if (!inside(node)) return;
      if (node.operator !== "===" && node.operator !== "!==" && node.operator !== "==" && node.operator !== "!=") {
        return;
      }
      const left = source.slice(node.left.start, node.left.end);
      const right = source.slice(node.right.start, node.right.end);
      if (!reference.test(left) && !reference.test(right)) return;
      if (node.left.type === "Literal" || node.right.type === "Literal") {
        comparesParameterToLiteral = true;
        pushExcerpt(node.start, node.end);
      }
    },
  }).visit(resolved.program);
  return { branchesOnParameter, comparesParameterToLiteral, branchExcerpts };
}

export function buildMysteryLiteralArgumentEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): MysteryLiteralArgumentEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  if (changes.length === 0) return undefined;

  const callSites: MysteryLiteralCallSite[] = [];

  for (const change of changes) {
    if (callSites.length >= MAX_SITES) break;
    const parsed = parseSync(change.filePath, change.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const calls: CallExpression[] = [];
    new Visitor({
      CallExpression(node) {
        calls.push(node);
      },
    }).visit(parsed.program);

    for (const call of calls) {
      if (callSites.length >= MAX_SITES) break;
      if (!lineInRanges(lineAt(change.source, call.start), change.changedLines)) continue;
      const root = calleeRootName(call.callee);
      if (!root || SKIPPED_CALLEES.has(root)) continue;

      call.arguments.forEach((argument, index) => {
        if (callSites.length >= MAX_SITES) return;
        if (argument.type !== "Literal") return;
        const kind = literalKind(argument.raw ?? null);
        if (!kind) return;

        const resolved = resolveCallee(root, change.filePath, parsed.program, projectFiles);
        if (!resolved) return;
        const parameter = resolved.fn.params[index];
        const parameterName = parameter === undefined ? undefined : bindingName(parameter);
        if (parameter === undefined || !parameterName) return;
        const facts = inspectCallee(resolved.file.source, resolved, parameterName);
        if (!facts.branchesOnParameter && !facts.comparesParameterToLiteral) return;

        const raw = argument.raw ?? "";
        const value = literalValue(raw);
        const typeMatch = /:\s*(.+)$/.exec(resolved.file.source.slice(parameter.start, parameter.end));
        callSites.push({
          filePath: change.filePath,
          line: lineAt(change.source, call.start),
          call: change.source.slice(call.start, call.end).slice(0, MAX_EXCERPT_CHARS),
          callee: root,
          argumentIndex: index,
          parameterName,
          parameterType: typeMatch?.[1]?.trim() ?? null,
          literal: value,
          literalKind: kind,
          conventional: kind === "string" && CONVENTIONAL_STRINGS.has(value.toLowerCase()),
          calleeBranchesOnParameter: facts.branchesOnParameter,
          calleeComparesParameterToLiteral: facts.comparesParameterToLiteral,
          branchExcerpts: facts.branchExcerpts,
        });
      });
    }
  }

  if (callSites.length === 0) return undefined;
  return {
    anchorFile: candidate.filePath,
    coverage: {
      totalFiles: changes.length,
      includedFiles: new Set(callSites.map(({ filePath }) => filePath)).size,
      includedFilePaths: [...new Set(callSites.map(({ filePath }) => filePath))].sort(),
    },
    callSites,
  };
}
