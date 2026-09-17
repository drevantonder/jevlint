import { Visitor } from "oxc-parser";
import type { Program } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { findFunctionCallers } from "./repository.js";
import type { FunctionNode } from "./repository.js";
import {
  buildModuleEvidence,
  isFrameworkScaffolded,
  parseProgram,
} from "./module.js";
import type { ModuleEvidence } from "./module.js";

export type ParamStyle = "options" | "positional";

export type SiblingExportStyle = {
  name: string;
  style: ParamStyle;
  arity: number;
};

export type MixedArityGroup = {
  arity: number;
  names: string[];
};

export type StyleCallerSample = {
  function: string;
  style: ParamStyle;
  calls: { filePath: string; call: string; caller: string | null; callerStyle: ParamStyle | null }[];
};

export type OptionsStyleSplitEvidence = {
  module: ModuleEvidence;
  exports: SiblingExportStyle[];
  majority: ParamStyle | "tie";
  mixedArityGroups: MixedArityGroup[];
  callers: StyleCallerSample[];
};

const OPTIONS_NAME_PATTERN = /^(options|opts|config|params|settings|args)$/i;
const OPTIONS_TYPE_PATTERN = /(options|config|params|settings|args)$/i;

function paramStyleOf(node: FunctionNode, ownerSource: string): ParamStyle | undefined {
  if (node.params.length === 0) return undefined;
  if (node.params.length === 1) {
    const only = node.params[0];
    if (!only) return "positional";
    const value = only.type === "TSParameterProperty" ? only.parameter : only;
    if (value.type === "ObjectPattern") return "options";
    if (value.type === "Identifier") {
      if (OPTIONS_NAME_PATTERN.test(value.name)) return "options";
      const annotation = ownerSource.slice(value.start, value.end);
      const typeMatch = /:\s*([A-Za-z_$][\w$]*(?:<[^;]*>)?)\s*(=|$)/.exec(annotation);
      if (typeMatch?.[1] && OPTIONS_TYPE_PATTERN.test(typeMatch[1].replace(/<.*$/, ""))) {
        return "options";
      }
      return "positional";
    }
    return "positional";
  }
  return "positional";
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function enclosingCall(
  filePath: string,
  source: string,
  line: number,
): { caller: string; callerStyle: ParamStyle | null } | undefined {
  const program = parseProgram(filePath, source);
  if (!program) return undefined;
  const offset = lineStarts(source)[line - 1] ?? 0;
  let best: { name: string; node: FunctionNode } | undefined;
  const consider = (name: string, node: FunctionNode): void => {
    if (node.start > offset || offset > node.end) return;
    if (!best || (node.start >= best.node.start && node.end <= best.node.end)) {
      best = { name, node };
    }
  };
  new Visitor({
    FunctionDeclaration(node) {
      if (node.id?.name) consider(node.id.name, node);
    },
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier") return;
      if (
        node.init?.type === "ArrowFunctionExpression"
        || node.init?.type === "FunctionExpression"
      ) consider(node.id.name, node.init);
    },
  }).visit(program);
  if (!best) return undefined;
  const first = best.node.params[0];
  const last = best.node.params[best.node.params.length - 1];
  const parameters = first && last ? source.slice(first.start, last.end) : "";
  return {
    caller: `${best.name}(${parameters})`,
    callerStyle: paramStyleOf(best.node, source) ?? null,
  };
}

function exportedFunctions(program: Program): { name: string; node: FunctionNode }[] {
  const result: { name: string; node: FunctionNode }[] = [];
  const declared = new Map<string, FunctionNode>();
  new Visitor({
    FunctionDeclaration(node) {
      if (node.id?.name && !declared.has(node.id.name)) declared.set(node.id.name, node);
    },
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier") return;
      if (
        node.init?.type === "ArrowFunctionExpression"
        || node.init?.type === "FunctionExpression"
      ) {
        if (!declared.has(node.id.name)) declared.set(node.id.name, node.init);
      }
    },
  }).visit(program);

  const exported = new Set<string>();
  for (const statement of program.body) {
    if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement.declaration;
      if (declaration.type === "FunctionDeclaration" && declaration.id?.name) {
        exported.add(declaration.id.name);
      }
      continue;
    }
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = statement.declaration;
    if (declaration?.type === "FunctionDeclaration" && declaration.id?.name) {
      exported.add(declaration.id.name);
    }
    if (
      declaration?.type === "VariableDeclaration"
      && declaration.declarations.every((item) => item.id.type === "Identifier")
    ) {
      for (const item of declaration.declarations) {
        if (item.id.type === "Identifier") exported.add(item.id.name);
      }
    }
    for (const specifier of statement.specifiers) {
      if (specifier.local.type === "Identifier") exported.add(specifier.local.name);
    }
  }
  for (const [name, node] of declared) {
    if (exported.has(name)) result.push({ name, node });
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

export function buildOptionsStyleSplitEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): OptionsStyleSplitEvidence | undefined {
  if (candidate.kind !== "module") return undefined;
  if (isFrameworkScaffolded(candidate.filePath)) return undefined;
  const module = buildModuleEvidence(candidate.filePath, changes, projectFiles);
  if (!module) return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const program = parseProgram(owner.filePath, owner.source);
  if (!program) return undefined;

  const exports: SiblingExportStyle[] = [];
  for (const { name, node } of exportedFunctions(program)) {
    const style = paramStyleOf(node, owner.source);
    if (!style) continue;
    exports.push({ name, style, arity: node.params.length });
  }
  if (exports.length < 2) return undefined;
  const optionsCount = exports.filter((item) => item.style === "options").length;
  if (optionsCount === 0 || optionsCount === exports.length) return undefined;

  const majority: ParamStyle | "tie" = optionsCount * 2 === exports.length
    ? "tie"
    : optionsCount * 2 > exports.length ? "options" : "positional";

  const byArity = new Map<number, string[]>();
  const styleByArity = new Map<number, Set<ParamStyle>>();
  for (const item of exports) {
    byArity.set(item.arity, [...(byArity.get(item.arity) ?? []), item.name]);
    const styles = styleByArity.get(item.arity) ?? new Set<ParamStyle>();
    styles.add(item.style);
    styleByArity.set(item.arity, styles);
  }
  const mixedArityGroups: MixedArityGroup[] = [...byArity.entries()]
    .filter(([arity]) => (styleByArity.get(arity)?.size ?? 0) > 1)
    .map(([arity, names]) => ({ arity, names: [...names].sort() }))
    .sort((left, right) => left.arity - right.arity);

  const callers: StyleCallerSample[] = [];
  const mixedNames = new Set(mixedArityGroups.flatMap((group) => group.names));
  const ordered = [...exports].sort((left, right) =>
    Number(mixedNames.has(right.name)) - Number(mixedNames.has(left.name))
    || left.name.localeCompare(right.name)
  );
  for (const style of ["options", "positional"] as const) {
    const representative = ordered.find((item) => item.style === style);
    if (!representative) continue;
    const calls = findFunctionCallers(candidate.filePath, representative.name, projectFiles)
      .slice(0, 3)
      .map(({ filePath, call, line }) => {
        const callerFile = projectFiles.find((file) => file.filePath === filePath);
        const enclosing = callerFile
          ? enclosingCall(filePath, callerFile.source, line)
          : undefined;
        return {
          filePath,
          call,
          caller: enclosing?.caller ?? null,
          callerStyle: enclosing?.callerStyle ?? null,
        };
      });
    callers.push({ function: representative.name, style, calls });
  }

  return { module, exports, majority, mixedArityGroups, callers };
}
