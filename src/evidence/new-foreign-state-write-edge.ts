import { Visitor } from "oxc-parser";
import type { AssignmentTarget, Expression } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import {
  buildModuleEvidence,
  moduleExportNames,
  parseProgram,
} from "./module.js";
import type { ModuleEvidence } from "./module.js";
import { moduleImports, moduleMutableBindings } from "./repository.js";

const MAX_WRITES = 10;
const MAX_BINDINGS = 20;
const MAX_SETTERS = 20;

const MUTATING_METHODS = new Set([
  "add",
  "clear",
  "copyWithin",
  "delete",
  "fill",
  "pop",
  "push",
  "reverse",
  "set",
  "shift",
  "sort",
  "splice",
  "unshift",
]);

const SETTER_NAME_PATTERN = /^(set|update|reset|put|add|remove|delete|mutate|write|dispatch|register|apply)[A-Z_]/;

export type ForeignStateWrite = {
  target: string;
  specifier: string;
  importedBinding: string;
  operation: string;
  targetIsTargetMutable: boolean;
  targetOffersSetter: boolean;
};

export type NewForeignStateWriteEdgeEvidence = {
  module: ModuleEvidence;
  writes: ForeignStateWrite[];
  targetMutableBindings: string[];
  targetSetterNames: string[];
};

function previousSpecifiers(filePath: string, oldSource: string | null): Set<string> | undefined {
  if (oldSource === null) return new Set();
  const program = parseProgram(filePath, oldSource);
  if (!program) return undefined;
  return new Set(moduleImports(program).map((item) => item.source));
}

function rootIdentifier(expression: AssignmentTarget | Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    return expression.object.type === "Super" ? undefined : rootIdentifier(expression.object);
  }
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  if (expression.type === "ParenthesizedExpression") return rootIdentifier(expression.expression);
  if (
    expression.type === "TSAsExpression"
    || expression.type === "TSNonNullExpression"
    || expression.type === "TSSatisfiesExpression"
    || expression.type === "TSTypeAssertion"
  ) return rootIdentifier(expression.expression);
  return undefined;
}

export function buildNewForeignStateWriteEdgeEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): NewForeignStateWriteEdgeEvidence | undefined {
  if (candidate.kind !== "module") return undefined;
  const module = buildModuleEvidence(candidate.filePath, changes, projectFiles);
  if (!module) return undefined;

  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const change = changes.find((item) => item.filePath === candidate.filePath);
  const previous = previousSpecifiers(candidate.filePath, change?.oldSource ?? null);
  if (!previous) return undefined;
  const program = parseProgram(owner.filePath, owner.source);
  if (!program) return undefined;

  const freshTargets = new Map<string, { target: string; specifier: string }>();
  for (const edge of module.importEdgesOut) {
    if (previous.has(edge.to)) continue;
    if (edge.resolved === null) continue;
    freshTargets.set(edge.to, { target: edge.resolved, specifier: edge.to });
  }
  if (freshTargets.size === 0) return undefined;

  const localToTarget = new Map<string, { target: string; specifier: string; imported: string }>();
  for (const imported of moduleImports(program)) {
    const fresh = freshTargets.get(imported.source);
    if (!fresh) continue;
    localToTarget.set(imported.local, {
      target: fresh.target,
      specifier: imported.source,
      imported: imported.imported,
    });
  }
  if (localToTarget.size === 0) return undefined;

  const byPath = new Map(projectFiles.map((file) => [file.filePath, file]));
  const mutableByTarget = new Map<string, Set<string>>();
  const settersByTarget = new Map<string, string[]>();
  for (const { target } of localToTarget.values()) {
    if (mutableByTarget.has(target)) continue;
    const file = byPath.get(target);
    const targetProgram = file ? parseProgram(file.filePath, file.source) : undefined;
    if (!targetProgram) {
      mutableByTarget.set(target, new Set());
      settersByTarget.set(target, []);
      continue;
    }
    mutableByTarget.set(
      target,
      new Set(moduleMutableBindings(targetProgram).map((binding) => binding.name)),
    );
    settersByTarget.set(
      target,
      moduleExportNames(targetProgram).filter((name) => SETTER_NAME_PATTERN.test(name)),
    );
  }

  const writes: ForeignStateWrite[] = [];
  const record = (
    node: { start: number; end: number },
    root: string | undefined,
    operation: string,
  ): void => {
    if (writes.length >= MAX_WRITES || root === undefined) return;
    const hit = localToTarget.get(root);
    if (!hit) return;
    const mutable = mutableByTarget.get(hit.target) ?? new Set();
    const setters = settersByTarget.get(hit.target) ?? [];
    writes.push({
      target: hit.target,
      specifier: hit.specifier,
      importedBinding: `${root} (${owner.source.slice(node.start, node.end).slice(0, 120)})`,
      operation,
      targetIsTargetMutable: hit.imported === "*" || mutable.has(hit.imported),
      targetOffersSetter: setters.length > 0,
    });
  };

  new Visitor({
    AssignmentExpression(node) {
      record(node, rootIdentifier(node.left), "assignment");
    },
    UpdateExpression(node) {
      record(node, rootIdentifier(node.argument), "update");
    },
    UnaryExpression(node) {
      if (node.operator !== "delete") return;
      record(node, rootIdentifier(node.argument), "delete");
    },
    CallExpression(node) {
      if (
        node.callee.type !== "MemberExpression"
        || node.callee.computed
        || node.callee.property.type !== "Identifier"
        || !MUTATING_METHODS.has(node.callee.property.name)
      ) return;
      const object = node.callee.object;
      if (object.type === "Super") return;
      record(node, rootIdentifier(object), "mutating-call");
    },
  }).visit(program);
  if (writes.length === 0) return undefined;

  const mutableBindings = [...new Set([...mutableByTarget.values()].flatMap((set) => [...set]))]
    .sort()
    .slice(0, MAX_BINDINGS);
  const setterNames = [...new Set([...settersByTarget.values()].flat())]
    .sort()
    .slice(0, MAX_SETTERS);

  return { module, writes, targetMutableBindings: mutableBindings, targetSetterNames: setterNames };
}
