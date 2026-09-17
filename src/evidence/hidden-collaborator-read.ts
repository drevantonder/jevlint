import { parseSync, Visitor } from "oxc-parser";
import type { BindingPattern, Expression, ParamPattern, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  nestedFunctionRanges,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

type CollaboratorOwnership = "imported-binding" | "this";

type CollaboratorRead = {
  expression: string;
  root: string;
  path: string;
  ownership: CollaboratorOwnership;
};

type StableConstant = {
  local: string;
  source: string;
};

type ExternalWriter = {
  binding: string;
  filePath: string;
  operation: string;
};

export type HiddenCollaboratorReadEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  reads: CollaboratorRead[];
  importedTargets: Array<{ local: string; source: string }>;
  stableConstants: StableConstant[];
  externalWriters: ExternalWriter[];
  callers: FunctionCaller[];
};

type SourceRange = {
  start: number;
  end: number;
};

function inRanges(ranges: SourceRange[], start: number, end: number): boolean {
  return ranges.some((range) => range.start <= start && range.end >= end);
}

function rootOf(expression: Expression): { root: string; path: string } | undefined {
  if (expression.type === "Identifier") return { root: expression.name, path: expression.name };
  if (expression.type === "ThisExpression") return { root: "this", path: "this" };
  if (expression.type === "Super") return undefined;
  if (
    expression.type === "ChainExpression"
    || expression.type === "ParenthesizedExpression"
    || expression.type === "TSAsExpression"
    || expression.type === "TSNonNullExpression"
    || expression.type === "TSSatisfiesExpression"
    || expression.type === "TSTypeAssertion"
  ) return rootOf(expression.expression);
  if (expression.type !== "MemberExpression") return undefined;
  if (expression.object.type === "Super") return undefined;
  const object = rootOf(expression.object);
  if (!object) return undefined;
  if (!expression.computed && expression.property.type === "Identifier") {
    return { root: object.root, path: `${object.path}.${expression.property.name}` };
  }
  return object;
}

function bindingNames(pattern: BindingPattern | ParamPattern): string[] {
  if (pattern.type === "Identifier") return [pattern.name];
  if (pattern.type === "AssignmentPattern") return bindingNames(pattern.left);
  if (pattern.type === "RestElement") return bindingNames(pattern.argument);
  if (pattern.type === "TSParameterProperty") return bindingNames(pattern.parameter);
  if (pattern.type === "ArrayPattern") {
    return pattern.elements.flatMap((element) => element ? bindingNames(element) : []);
  }
  return pattern.properties.flatMap((property) =>
    property.type === "RestElement" ? bindingNames(property.argument) : bindingNames(property.value),
  );
}

function isLiteralInit(node: Expression): boolean {
  if (node.type === "Literal") return true;
  if (node.type === "TemplateLiteral") return node.expressions.length === 0;
  if (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+")) {
    return node.argument.type === "Literal";
  }
  return false;
}

function literalConstExports(program: Program): Set<string> {
  const constLiterals = new Set<string>();
  const exported = new Set<string>();
  for (const statement of program.body) {
    if (statement.type === "VariableDeclaration" && statement.kind === "const") {
      for (const declarator of statement.declarations) {
        if (
          declarator.id.type === "Identifier"
          && declarator.init
          && isLiteralInit(declarator.init)
        ) constLiterals.add(declarator.id.name);
      }
    }
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = statement.declaration;
    if (declaration?.type === "VariableDeclaration" && declaration.kind === "const") {
      for (const declarator of declaration.declarations) {
        if (
          declarator.id.type === "Identifier"
          && declarator.init
          && isLiteralInit(declarator.init)
        ) {
          constLiterals.add(declarator.id.name);
          exported.add(declarator.id.name);
        }
      }
    }
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ExportSpecifier" && specifier.local.type === "Identifier") {
        exported.add(specifier.local.name);
      }
    }
  }
  return new Set([...constLiterals].filter((name) => exported.has(name)));
}

function methodName(program: Program, fn: FunctionNode): string | undefined {
  let result: string | undefined;
  new Visitor({
    MethodDefinition(node) {
      if (!result && node.value === fn && node.key.type === "Identifier") {
        result = node.key.name;
      }
    },
  }).visit(program);
  return result;
}

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

function writeOperationsTo(source: string, program: Program, name: string): Array<{ operation: string; start: number; end: number }> {
  const operations: Array<{ operation: string; start: number; end: number }> = [];
  const matches = (expression: Expression): boolean => {
    const info = rootOf(expression);
    return info?.root === name;
  };
  const record = (node: { start: number; end: number }): void => {
    operations.push({
      operation: source.slice(node.start, node.end).replaceAll(/\s+/g, " ").slice(0, 160),
      start: node.start,
      end: node.end,
    });
  };
  new Visitor({
    AssignmentExpression(node) {
      if (node.left.type !== "Identifier" && node.left.type !== "MemberExpression") return;
      if (matches(node.left)) record(node);
    },
    UpdateExpression(node) {
      if (node.argument.type !== "Identifier" && node.argument.type !== "MemberExpression") return;
      if (matches(node.argument)) record(node);
    },
    UnaryExpression(node) {
      if (node.operator !== "delete" || node.argument.type !== "MemberExpression") return;
      if (matches(node.argument)) record(node);
    },
    CallExpression(node) {
      if (
        node.callee.type !== "MemberExpression"
        || node.callee.computed
        || node.callee.property.type !== "Identifier"
        || !MUTATING_METHODS.has(node.callee.property.name)
      ) return;
      if (matches(node.callee.object)) record(node);
    },
  }).visit(program);
  return operations;
}

export function buildHiddenCollaboratorReadEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HiddenCollaboratorReadEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn) ?? methodName(parsed.program, fn);
  if (!name) return undefined;

  const imports = moduleImports(parsed.program);
  const importSource = new Map(imports.map(({ local, source }) => [local, source] as const));
  const nested = nestedFunctionRanges(parsed.program, candidate);
  const inScope = (node: SourceRange): boolean =>
    node.start >= candidate.start
    && node.end <= candidate.end
    && !nested.some((range) => range.start <= node.start && range.end >= node.end);

  const calleeRanges: SourceRange[] = [];
  const typeRanges: SourceRange[] = [];
  const declarationRanges: SourceRange[] = [];
  const memberHits: Array<{ expression: string; root: string; path: string; start: number; end: number }> = [];
  const shadowed = new Set(fn.params.flatMap(bindingNames));

  new Visitor({
    TSTypeAnnotation(node) {
      typeRanges.push(node);
    },
    TSTypeQuery(node) {
      typeRanges.push(node);
    },
    CallExpression(node) {
      if (!inScope(node)) return;
      if (node.callee.type === "Identifier") calleeRanges.push({ start: node.callee.start, end: node.callee.end });
    },
    NewExpression(node) {
      if (!inScope(node)) return;
      if (node.callee.type === "Identifier") calleeRanges.push({ start: node.callee.start, end: node.callee.end });
    },
    VariableDeclarator(node) {
      if (!inScope(node)) return;
      declarationRanges.push({ start: node.id.start, end: node.id.end });
      for (const binding of bindingNames(node.id)) shadowed.add(binding);
    },
    FunctionDeclaration(node) {
      if (node.id && node.start >= candidate.start && node.end <= candidate.end) {
        declarationRanges.push({ start: node.id.start, end: node.id.end });
        shadowed.add(node.id.name);
      }
    },
    CatchClause(node) {
      if (!node.param || !inScope(node)) return;
      declarationRanges.push({ start: node.param.start, end: node.param.end });
      for (const binding of bindingNames(node.param)) shadowed.add(binding);
    },
    MemberExpression(node) {
      if (!inScope(node)) return;
      const info = rootOf(node);
      if (!info) return;
      if (!node.computed && node.property.type === "Identifier") {
        declarationRanges.push({ start: node.property.start, end: node.property.end });
      }
      const imported = importSource.get(info.root);
      if (info.root !== "this" && imported === undefined) return;
      memberHits.push({
        expression: owner.source.slice(node.start, node.end).replaceAll(/\s+/g, " ").slice(0, 200),
        root: info.root,
        path: info.path,
        start: node.start,
        end: node.end,
      });
    },
  }).visit(parsed.program);

  const outermostMembers = memberHits.filter((hit) => !memberHits.some((other) =>
    other !== hit && other.start <= hit.start && other.end >= hit.end
  ));
  const memberRanges: SourceRange[] = outermostMembers;

  type BareHit = { expression: string; root: string; start: number; end: number };
  const bareHits: BareHit[] = [];
  new Visitor({
    Identifier(node) {
      if (!inScope(node)) return;
      if (inRanges(typeRanges, node.start, node.end)) return;
      if (inRanges(calleeRanges, node.start, node.end)) return;
      if (inRanges(declarationRanges, node.start, node.end)) return;
      if (inRanges(memberRanges, node.start, node.end)) return;
      if (importSource.get(node.name) === undefined) return;
      bareHits.push({
        expression: owner.source.slice(node.start, node.end).slice(0, 120),
        root: node.name,
        start: node.start,
        end: node.end,
      });
    },
  }).visit(parsed.program);

  const stableConstants: StableConstant[] = [];
  const stableRoots = new Set<string>();
  for (const { local, source, imported } of imports) {
    if (imported === "*" || imported === "default") continue;
    const target = resolveModule(owner.filePath, source, projectFiles);
    if (!target) continue;
    const targetParsed = parseSync(target.filePath, target.source, { range: true });
    if (targetParsed.errors.some((error) => error.severity === "Error")) continue;
    if (literalConstExports(targetParsed.program).has(imported)) {
      stableRoots.add(local);
      stableConstants.push({ local, source });
    }
  }

  const reads: CollaboratorRead[] = [];
  const seen = new Set<string>();
  const push = (read: CollaboratorRead): void => {
    if (shadowed.has(read.root)) return;
    if (stableRoots.has(read.root)) return;
    if (read.root !== "this" && importSource.get(read.root) === undefined) return;
    const key = `${read.ownership ?? ""}:${read.path}:${read.expression}`;
    if (seen.has(key)) return;
    seen.add(key);
    reads.push(read);
  };
  for (const hit of outermostMembers) {
    push({
      expression: hit.expression,
      root: hit.root,
      path: hit.path,
      ownership: hit.root === "this" ? "this" : "imported-binding",
    });
  }
  for (const hit of bareHits) {
    push({
      expression: hit.expression,
      root: hit.root,
      path: hit.root,
      ownership: "imported-binding",
    });
  }

  if (reads.length === 0) return undefined;

  const externalWriters: ExternalWriter[] = [];
  const readRoots = [...new Set(reads.filter(({ ownership }) => ownership === "imported-binding").map(({ root }) => root))];
  const scanned = new Set<string>();
  for (const root of readRoots) {
    const source = importSource.get(root);
    if (!source) continue;
    const specifier = imports.find(({ local }) => local === root);
    const exportedName = specifier?.imported ?? root;
    const targets: Array<{ file: ProjectFile; names: string[] }> = [];
    const defining = resolveModule(owner.filePath, source, projectFiles);
    if (defining && !scanned.has(defining.filePath)) {
      scanned.add(defining.filePath);
      targets.push({ file: defining, names: exportedName === "*" || exportedName === "default" ? [] : [exportedName] });
    }
    for (const file of projectFiles) {
      if (scanned.has(file.filePath) || file.filePath === defining?.filePath) continue;
      if (targets.length >= 10) break;
      const fileParsed = parseSync(file.filePath, file.source, { range: true });
      if (fileParsed.errors.some((error) => error.severity === "Error")) continue;
      const locals = moduleImports(fileParsed.program)
        .filter(({ source: from, imported: symbol }) => from === source && symbol === exportedName)
        .map(({ local }) => local);
      if (locals.length > 0) {
        scanned.add(file.filePath);
        targets.push({ file, names: locals });
      }
    }
    for (const { file, names } of targets) {
      if (externalWriters.length >= 5) break;
      const fileParsed = parseSync(file.filePath, file.source, { range: true });
      if (fileParsed.errors.some((error) => error.severity === "Error")) continue;
      for (const binding of names) {
        for (const { operation, start, end } of writeOperationsTo(file.source, fileParsed.program, binding)) {
          if (
            file.filePath === owner.filePath
            && start >= candidate.start
            && end <= candidate.end
          ) continue;
          externalWriters.push({ binding: `${file.filePath}:${binding}`, filePath: file.filePath, operation });
          if (externalWriters.length >= 5) break;
        }
        if (externalWriters.length >= 5) break;
      }
    }
  }

  const touchedRoots = new Set(reads.map(({ root }) => root));
  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    reads: reads.slice(0, 20),
    importedTargets: imports
      .filter(({ local }) => touchedRoots.has(local))
      .map(({ local, source }) => ({ local, source })),
    stableConstants,
    externalWriters,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
