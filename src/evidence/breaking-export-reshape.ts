import { parseSync, Visitor } from "oxc-parser";
import type { Function as OxcFunction, Program } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { findFunctionCallers } from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

const MAX_BREAKS = 10;
const MAX_STALE_CALLERS = 6;
const MAX_EXCERPT_CHARS = 500;

export type BrokenExportKind =
  | "removed-export"
  | "newly-required-parameter"
  | "narrowed-annotation";

export type BrokenExport = {
  filePath: string;
  exportName: string;
  kind: BrokenExportKind;
  before: string;
  after: string;
  shimPreserved: boolean;
  staleCallers: FunctionCaller[];
};

export type BreakingExportEvidence = {
  anchorFile: string;
  coverage: {
    totalFiles: number;
    comparedFiles: number;
  };
  contractBreaks: BrokenExport[];
};

type ExportSignature = {
  name: string;
  requiredParams: number;
  totalParams: number;
  annotation: string;
  excerpt: string;
};

function bindingSignature(
  node: FunctionNode | OxcFunction,
  name: string,
  source: string,
): ExportSignature {
  const params = node.params.map((parameter) => source.slice(parameter.start, parameter.end));
  const required = params.filter((text) => {
    const trimmed = text.trim();
    if (trimmed.includes("=")) return false;
    return !/\?\s*:/.test(trimmed) && !trimmed.endsWith("?");
  }).length;
  const paramsEnd = node.params.length > 0 ? node.params[node.params.length - 1]?.end : undefined;
  const bodyStart = node.body?.start;
  let annotation = "";
  if (paramsEnd !== undefined && bodyStart !== undefined) {
    const between = source.slice(paramsEnd, bodyStart);
    const match = /\)\s*:\s*(.+?)\s*(?:=>)?$/.exec(between.trim());
    annotation = match?.[1]?.trim() ?? "";
  }
  return {
    name,
    requiredParams: required,
    totalParams: params.length,
    annotation,
    excerpt: source.slice(node.start, node.end).slice(0, MAX_EXCERPT_CHARS),
  };
}

function exportSignatures(program: Program, source: string): Map<string, ExportSignature> {
  const result = new Map<string, ExportSignature>();
  const add = (name: string | undefined, node: FunctionNode | OxcFunction): void => {
    if (name && !result.has(name)) result.set(name, bindingSignature(node, name, source));
  };
  for (const statement of program.body) {
    if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") {
      const declaration = statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement.declaration;
      if (declaration?.type === "FunctionDeclaration") {
        add(declaration.id?.name ?? (statement.type === "ExportDefaultDeclaration" ? "default" : undefined), declaration);
        continue;
      }
      if (declaration?.type === "VariableDeclaration") {
        for (const item of declaration.declarations) {
          if (item.id.type !== "Identifier" || !item.init) continue;
          if (
            item.init.type === "ArrowFunctionExpression"
            || item.init.type === "FunctionExpression"
          ) add(item.id.name, item.init);
        }
        continue;
      }
    }
    if (statement.type === "FunctionDeclaration" && statement.id) {
      add(statement.id.name, statement);
      continue;
    }
    if (statement.type === "VariableDeclaration") {
      for (const item of statement.declarations) {
        if (item.id.type !== "Identifier" || !item.init) continue;
        if (
          item.init.type === "ArrowFunctionExpression"
          || item.init.type === "FunctionExpression"
        ) add(item.id.name, item.init);
      }
    }
  }
  new Visitor({
    TSDeclareFunction(node: OxcFunction) {
      if (node.id?.name && !result.has(node.id.name)) {
        result.set(node.id.name, bindingSignature(node, node.id.name, source));
      }
    },
  }).visit(program);
  return result;
}

function annotationNarrowed(before: string, after: string): boolean {
  if (!before || !after || before === after) return false;
  const beforeParts = before.split("|").map((part) => part.trim());
  const afterParts = after.split("|").map((part) => part.trim());
  if (afterParts.length < beforeParts.length) return true;
  return afterParts.some((part) => !beforeParts.includes(part) && !/deprecated/i.test(part));
}

function overloadCount(program: Program, name: string): number {
  let count = 0;
  new Visitor({
    TSDeclareFunction(node: OxcFunction) {
      if (node.id?.name === name) count += 1;
    },
  }).visit(program);
  return count;
}

export function buildBreakingExportEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): BreakingExportEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  const contractBreaks: BrokenExport[] = [];
  let compared = 0;

  const ordered = [...changes].sort((left, right) => {
    if (left.filePath === candidate.filePath) return -1;
    if (right.filePath === candidate.filePath) return 1;
    return left.filePath.localeCompare(right.filePath);
  });

  for (const change of ordered) {
    if (contractBreaks.length >= MAX_BREAKS) break;
    if (change.oldSource === null) continue;
    const beforeParsed = parseSync(change.filePath, change.oldSource, { range: true });
    const afterParsed = parseSync(change.filePath, change.source, { range: true });
    if (
      beforeParsed.errors.some((error) => error.severity === "Error")
      || afterParsed.errors.some((error) => error.severity === "Error")
    ) continue;
    compared += 1;
    const before = exportSignatures(beforeParsed.program, change.oldSource);
    const after = exportSignatures(afterParsed.program, change.source);

    for (const [name, beforeSig] of before) {
      if (contractBreaks.length >= MAX_BREAKS) break;
      const afterSig = after.get(name);
      if (!afterSig) {
        const preserved = new RegExp(`\\bexport\\b[^;]*\\b${name}\\b`).test(change.source)
          || new RegExp(`\\b${name}\\s+as\\b|\\bas\\s+${name}\\b`).test(change.source);
        if (preserved) continue;
        const staleCallers = findFunctionCallers(change.filePath, name, projectFiles)
          .slice(0, MAX_STALE_CALLERS);
        contractBreaks.push({
          filePath: change.filePath,
          exportName: name,
          kind: "removed-export",
          before: beforeSig.excerpt,
          after: "",
          shimPreserved: preserved,
          staleCallers,
        });
        continue;
      }
      if (afterSig.requiredParams > beforeSig.requiredParams) {
        const staleCallers = findFunctionCallers(change.filePath, name, projectFiles)
          .filter((caller) => caller.arguments.length < afterSig.requiredParams)
          .slice(0, MAX_STALE_CALLERS);
        contractBreaks.push({
          filePath: change.filePath,
          exportName: name,
          kind: "newly-required-parameter",
          before: beforeSig.excerpt,
          after: afterSig.excerpt,
          shimPreserved: overloadCount(afterParsed.program, name) > 1,
          staleCallers,
        });
        continue;
      }
      if (annotationNarrowed(beforeSig.annotation, afterSig.annotation)) {
        contractBreaks.push({
          filePath: change.filePath,
          exportName: name,
          kind: "narrowed-annotation",
          before: beforeSig.excerpt,
          after: afterSig.excerpt,
          shimPreserved: overloadCount(afterParsed.program, name) > 1,
          staleCallers: findFunctionCallers(change.filePath, name, projectFiles)
            .slice(0, MAX_STALE_CALLERS),
        });
      }
    }
  }

  if (contractBreaks.length === 0) return undefined;
  return {
    anchorFile: candidate.filePath,
    coverage: {
      totalFiles: changes.length,
      comparedFiles: compared,
    },
    contractBreaks,
  };
}
