import { posix } from "node:path";
import { Visitor, visitorKeys } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type {
  ArrowFunctionExpression,
  CallExpression,
  Expression,
  Function as OxcFunction,
  ImportDeclaration,
  Node,
  Program,
  TSInterfaceDeclaration,
  TSTypeAliasDeclaration,
} from "oxc-parser";
import { z } from "zod";
import type { Candidate, ProjectFile } from "../types.js";

export type FunctionNode = OxcFunction | ArrowFunctionExpression;

export type ModuleImport = {
  source: string;
  local: string;
  imported: string;
};

export type FunctionCaller = {
  filePath: string;
  call: string;
  arguments: string[];
  line: number;
  /** How the candidate is used. Absent means a direct call (legacy shape);
   * "reference" means a references-as-values use: the candidate passed or
   * held as a value (`.map(fn)`, `const g = fn`, `return fn`) rather than
   * invoked at the site. */
  kind?: "call" | "reference";
};

export type FunctionCallersCoverage = {
  callers: FunctionCaller[];
  total: number;
};

export type RelatedProjectModule = {
  filePath: string;
  importedFrom: string;
  importedSymbols: string[];
  source: string;
};

type SourceRange = {
  start: number;
  end: number;
};

interface ImportedCallNames {
  identifiers: Set<string>;
  namespaces: Set<string>;
}

function importedName(specifier: ImportDeclaration["specifiers"][number]): string {
  if (specifier.type === "ImportSpecifier") {
    return specifier.imported.type === "Identifier"
      ? specifier.imported.name
      : specifier.imported.value;
  }
  return specifier.type === "ImportDefaultSpecifier" ? "default" : "*";
}

export function moduleImports(program: Program): ModuleImport[] {
  const result: ModuleImport[] = [];
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers) {
      result.push({
        source: statement.source.value,
        local: specifier.local.name,
        imported: importedName(specifier),
      });
    }
  }
  return result;
}

export function findDirectFunction(
  program: Program,
  candidate: Candidate,
): FunctionNode | undefined {
  let result: FunctionNode | undefined;
  const matches = (node: FunctionNode): void => {
    if (node.start === candidate.start && node.end === candidate.end) result = node;
  };
  new Visitor({
    ArrowFunctionExpression: matches,
    FunctionDeclaration: matches,
    FunctionExpression: matches,
  }).visit(program);
  return result;
}

export function nestedFunctionRanges(
  program: Program,
  candidate: Candidate,
): SourceRange[] {
  const ranges: SourceRange[] = [];
  const addRange = (node: FunctionNode): void => {
    if (
      node.start >= candidate.start
      && node.end <= candidate.end
      && (node.start !== candidate.start || node.end !== candidate.end)
    ) ranges.push({ start: node.start, end: node.end });
  };
  new Visitor({
    ArrowFunctionExpression: addRange,
    FunctionDeclaration: addRange,
    FunctionExpression: addRange,
  }).visit(program);
  return ranges;
}

export function isInsideNestedFunction(node: Node, ranges: SourceRange[]): boolean {
  return ranges.some((range) => range.start <= node.start && range.end >= node.end);
}

export function functionName(program: Program, node: FunctionNode): string | undefined {
  if (node.id?.name) return node.id.name;
  let name: string | undefined;
  new Visitor({
    VariableDeclarator(declaration) {
      if (declaration.init === node && declaration.id.type === "Identifier") {
        name = declaration.id.name;
      }
    },
  }).visit(program);
  return name;
}

export function isFunctionExported(
  program: Program,
  node: FunctionNode,
  name: string,
): boolean {
  for (const statement of program.body) {
    if (statement.type === "ExportDefaultDeclaration" && statement.declaration === node) return true;
    if (statement.type !== "ExportNamedDeclaration") continue;
    if (statement.declaration === node) return true;
    if (
      statement.declaration?.type === "VariableDeclaration"
      && statement.declaration.declarations.some((declaration) => declaration.init === node)
    ) return true;
    if (statement.specifiers.some((specifier) => {
      const local = specifier.local;
      return local.type === "Identifier" && local.name === name;
    })) return true;
  }
  return false;
}

function possibleModulePaths(fromFile: string, specifier: string): string[] {
  if (!specifier.startsWith(".")) return [];
  const joined = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
  const withoutKnownExtension = joined.replace(/\.(?:[cm]?[jt]sx?)$/, "");
  return [
    joined,
    `${withoutKnownExtension}.ts`,
    `${withoutKnownExtension}.tsx`,
    `${withoutKnownExtension}.mts`,
    `${withoutKnownExtension}.cts`,
    `${withoutKnownExtension}.js`,
    `${withoutKnownExtension}.jsx`,
    `${withoutKnownExtension}/index.ts`,
    `${withoutKnownExtension}/index.tsx`,
    `${withoutKnownExtension}/index.js`,
  ];
}

export function resolveModule(
  fromFile: string,
  specifier: string,
  projectFiles: ProjectFile[],
): ProjectFile | undefined {
  const paths = new Set(possibleModulePaths(fromFile, specifier));
  return projectFiles.find((file) => paths.has(posix.normalize(file.filePath)));
}

export function findRelatedProjectModules(
  ownerPath: string,
  program: Program,
  projectFiles: ProjectFile[],
): RelatedProjectModule[] {
  const modules = new Map<string, RelatedProjectModule>();
  for (const imported of moduleImports(program)) {
    const resolved = resolveModule(ownerPath, imported.source, projectFiles);
    if (!resolved || resolved.filePath === ownerPath) continue;
    const existing = modules.get(resolved.filePath);
    if (existing) {
      if (!existing.importedSymbols.includes(imported.imported)) {
        existing.importedSymbols.push(imported.imported);
      }
      continue;
    }
    modules.set(resolved.filePath, {
      filePath: resolved.filePath,
      importedFrom: imported.source,
      importedSymbols: [imported.imported],
      source: resolved.source.slice(0, 12_000),
    });
  }
  return [...modules.values()].slice(0, 12);
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

const SOURCE_EXTENSION_SUFFIX = /\.(?:[cm]?[jt]sx?)$/i;

/** ESM-style `.js` specifier fallback: at runtime `../src/splitter.js` names the
 * sibling `.ts` source, so an import targets the owner even when literal
 * resolution misses it (a compiled `.js` shadow sorts first in project files,
 * or no sibling file matches the literal path). One hop, same-file-or-sibling
 * only: the specifier must be relative and share the owner's stem after
 * stripping known source extensions. No node_modules or disk crawling, and
 * non-relative (bare or aliased) specifiers never match. */
function specifierTargetsOwner(
  callerPath: string,
  specifier: string,
  ownerPath: string,
): boolean {
  if (!specifier.startsWith(".")) return false;
  const joined = posix.normalize(posix.join(posix.dirname(callerPath), specifier));
  return (
    joined.replace(SOURCE_EXTENSION_SUFFIX, "")
    === posix.normalize(ownerPath).replace(SOURCE_EXTENSION_SUFFIX, "")
  );
}

function importedCallNames(
  program: Program,
  callerPath: string,
  ownerPath: string,
  functionName: string,
  projectFiles: ProjectFile[],
): ImportedCallNames {
  const identifiers = new Set<string>();
  const namespaces = new Set<string>();
  for (const imported of moduleImports(program)) {
    const resolved = resolveModule(callerPath, imported.source, projectFiles);
    if (
      resolved?.filePath !== ownerPath
      && !specifierTargetsOwner(callerPath, imported.source, ownerPath)
    ) continue;
    if (imported.imported === functionName || imported.imported === "default") {
      identifiers.add(imported.local);
    } else if (imported.imported === "*") {
      namespaces.add(imported.local);
    }
  }
  return { identifiers, namespaces };
}

function isMatchingCall(
  call: CallExpression,
  functionName: string,
  identifiers: Set<string>,
  namespaces: Set<string>,
): boolean {
  if (call.callee.type === "Identifier") return identifiers.has(call.callee.name);
  if (
    call.callee.type === "MemberExpression"
    && call.callee.object.type === "Identifier"
    && namespaces.has(call.callee.object.name)
    && call.callee.property.type === "Identifier"
  ) return call.callee.property.name === functionName;
  return false;
}

function collectFunctionCallers(
  ownerPath: string,
  functionName: string,
  projectFiles: ProjectFile[],
): FunctionCaller[] {
  const result: FunctionCaller[] = [];
  for (const file of projectFiles) {
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const names = file.filePath === ownerPath
      ? { identifiers: new Set([functionName]), namespaces: new Set<string>() }
      : importedCallNames(
        parsed.program,
        file.filePath,
        ownerPath,
        functionName,
        projectFiles,
      );
    if (names.identifiers.size === 0 && names.namespaces.size === 0) continue;
    new Visitor({
      CallExpression(call) {
        if (!isMatchingCall(call, functionName, names.identifiers, names.namespaces)) return;
        result.push({
          filePath: file.filePath,
          call: file.source.slice(call.start, call.end),
          arguments: call.arguments.map((argument) => file.source.slice(argument.start, argument.end)),
          line: lineAt(file.source, call.start),
        });
      },
    }).visit(parsed.program);
  }
  return result;
}

export function findFunctionCallers(
  ownerPath: string,
  functionName: string,
  projectFiles: ProjectFile[],
): FunctionCaller[] {
  return collectFunctionCallers(ownerPath, functionName, projectFiles).slice(0, 20);
}

export function findFunctionCallersWithCoverage(
  ownerPath: string,
  functionName: string,
  projectFiles: ProjectFile[],
): FunctionCallersCoverage {
  const callers = collectFunctionCallers(ownerPath, functionName, projectFiles);
  return { callers, total: callers.length };
}

// ---------------------------------------------------------------------------
// References-as-values pass.
//
// The direct-call pass above only sees `fn(...)` invocations. Production code
// also keeps a helper live by holding it as a value: `files.map(fn)` passes
// it as a callback, `const g = fn` aliases it, `return fn` / `export { fn }`
// (from another module) forward it. Those bare-identifier reads in expression
// positions count as production callers/references alongside direct calls.
//
// Counted as references (value reads of the candidate binding): call
// arguments including spreads, variable initializers, assignment right-hand
// sides, return/throw arguments, array elements, object property values,
// computed keys, template/conditional/binary operands, await/yield operands,
// class heritage (`extends fn`), decorators, `new fn()` callees (the call
// pass never visits NewExpression), tagged-template tags, enum member
// initializers, class field initializers, and namespace member reads
// (`ns.fn`) outside counted-call callee positions.
//
// Explicitly NOT counted, each decided deliberately:
// - Comments and strings: the scan walks the AST, so non-code text can never
//   surface an identifier.
// - Import statements of the candidate's own declaration: specifier locals
//   are bindings, not reads; they seed scope resolution instead.
// - The candidate's own declaration range: self-recursion is not caller
//   evidence (mirrors the textual same-file-references exclusion). Note the
//   call pass still counts self-calls; that asymmetry predates this pass and
//   is out of scope.
// - The owner file's own export of the candidate (`export { fn }`,
//   `export default fn`): that statement IS the export mechanism, and
//   counting it would make every export-list export self-referential.
//   Re-exports with a `source` (`export { fn } from "./owner"`) are skipped
//   here because re-export paths are already separate evidence.
// - Direct-call callee positions the call pass already counts (`fn()`,
//   `ns.fn()`): counted once, as calls, so direct-call behavior is unchanged.
// - Non-computed member properties and object keys (`obj.fn`, `{ fn: 1 }`),
//   labels, and `UpdateExpression` operands: not binding reads.
// - Assignment left-hand writes (`fn = ...`): a write is not a use.
// - Type-only subtrees (annotations, references, queries, aliases,
//   interfaces, declare forms, module declarations, import types, predicates,
//   type arguments): types name the helper without keeping it live at
//   runtime. `typeof fn` in a *value* (`const t = typeof fn`) still counts
//   because the unary operator evaluates at runtime.
// - JSX subtrees: consistent with the call pass, which never counted JSX
//   use either. A component used only as `<Fn />` stays invisible to both
//   passes; lifting that is follow-up work, not this fix.
// - CommonJS `require`: consistent with the call pass, which only reads ESM
//   `ImportDeclaration` bindings.
// - Block scoping is simplified (bindings visible through their block,
//   hoisting ignored): over-shadowing misses pathological TDZ reads rather
//   than inventing callers, which is the safe direction.
// - Default-import aliasing mirrors the call pass approximation: any default
//   import from the owner module counts, whether or not the candidate is the
//   default export. Tightening that changes call-pass behavior; out of scope.

/** Node types whose entire subtree is type-level: walking in never observes a
 * runtime read. Enum declarations are deliberately absent: member
 * initializers evaluate at runtime. */
const TYPE_SUBTREE_ROOTS = new Set([
  "TSTypeAnnotation",
  "TSTypeQuery",
  "TSTypeReference",
  "TSTypeParameterDeclaration",
  "TSTypeParameterInstantiation",
  "TSTypeAliasDeclaration",
  "TSInterfaceDeclaration",
  "TSDeclareFunction",
  "TSModuleDeclaration",
  "TSImportType",
  "TSTypePredicate",
]);

const EXCERPT_CHARS = 240;

type ReferenceBinding =
  | { kind: "candidate" }
  | { kind: "ownerImport" }
  | { kind: "namespace" }
  | { kind: "shadow" };

interface ReferenceScan {
  source: string;
  filePath: string;
  isOwner: boolean;
  candidateName: string;
  candidateStart: number;
  candidateEnd: number;
  /** Local names the call pass counts as direct-call callees. */
  identifiers: Set<string>;
  namespaces: Set<string>;
  scopes: Map<string, ReferenceBinding>[];
  ancestors: Node[];
  results: FunctionCaller[];
}

/** Field shapes an oxc AST node can expose through its visitor keys: child
 * nodes, child node arrays, or JSON scalars. */
type AstField = Node | Node[] | string | number | boolean | null | undefined;

interface PositionedChild {
  type: string;
  start: number;
  end: number;
}

function scopeTop(scan: ReferenceScan): Map<string, ReferenceBinding> {
  const top = scan.scopes[scan.scopes.length - 1];
  if (top === undefined) throw new Error("reference scan entered with no scope");
  return top;
}

function resolveReferenceBinding(scan: ReferenceScan, name: string): ReferenceBinding | undefined {
  for (let index = scan.scopes.length - 1; index >= 0; index -= 1) {
    const binding = scan.scopes[index]?.get(name);
    if (binding !== undefined) return binding;
  }
  return undefined;
}

function bindReferenceName(
  scan: ReferenceScan,
  name: string,
  selfStart: number | undefined,
  selfEnd: number | undefined,
): void {
  const isSelf = scan.isOwner
    && name === scan.candidateName
    && selfStart === scan.candidateStart
    && selfEnd === scan.candidateEnd;
  scopeTop(scan).set(name, { kind: isSelf ? "candidate" : "shadow" });
}

/** Genuine positioned child nodes for the visitor-key fields of one AST node.
 * Scalars, nulls, and non-node objects never enter the walk. */
function asPositionedChild(value: AstField): Node | undefined {
  if (value === null || value === undefined || Array.isArray(value)) return undefined;
  if (!(value instanceof Object)) return undefined;
  // SAFETY: values reaching here come from visitorKeys-listed child fields of
  // parsed oxc AST nodes; the integer-offset check below admits only genuine
  // positioned child nodes, so viewing type/start/end is sound.
  const view = value as PositionedChild;
  if (!Number.isInteger(view.start) || !Number.isInteger(view.end)) return undefined;
  if (!Object.hasOwn(visitorKeys, view.type)) return undefined;
  // SAFETY: the checks above established a positioned node of a known AST
  // type, which is exactly what the oxc Node union classifies.
  return view as Node;
}

function childNodes(node: Node): Node[] {
  const fields = visitorKeys[node.type];
  if (fields === undefined) return [];
  // SAFETY: wanted names exactly the visitor-key child fields of this AST
  // node, so the entries admitted below are that node's own child slots;
  // every value still returns through the positioned-child guard, which
  // admits only genuine positioned child nodes into the walk.
  const wanted = new Set(fields);
  const result: Node[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (!wanted.has(key)) continue;
    // SAFETY: key is a visitor-key child field of this AST node, so the
    // entry value is one of that field's declared shapes: child node,
    // node array, or JSON scalar, all covered by AstField.
    const field = value as AstField;
    if (field === null || field === undefined) continue;
    if (Array.isArray(field)) {
      for (const item of field) {
        const child = asPositionedChild(item);
        if (child !== undefined) result.push(child);
      }
      continue;
    }
    const child = asPositionedChild(field);
    if (child !== undefined) result.push(child);
  }
  return result;
}

function excerptForReference(scan: ReferenceScan, node: Node): string {
  const ancestors = scan.ancestors;
  const parent = ancestors[ancestors.length - 1];
  // `new fn()` / `tag`fn``: the callee/tag read names the site, so excerpt
  // the whole construction instead of the enclosing statement.
  if (
    parent !== undefined
    && (parent.type === "NewExpression" || parent.type === "TaggedTemplateExpression")
  ) {
    return scan.source.slice(parent.start, parent.end);
  }
  // `files.map(fn)`: excerpt the call receiving the reference, including
  // through a spread argument (`f(...fn)`).
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if (ancestor === undefined || ancestor.type !== "CallExpression") continue;
    const direct = ancestor.arguments.some((argument) => {
      if (argument === node) return true;
      return argument.type === "SpreadElement" && argument.argument === node;
    });
    if (direct) return scan.source.slice(ancestor.start, ancestor.end);
  }
  // Otherwise the nearest statement-like ancestor names the site. Export
  // specifiers are skipped in favor of the whole export declaration, so
  // `export { fn };` excerpts read as the export rather than a bare name.
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const ancestor = ancestors[index];
    if (ancestor === undefined) continue;
    if (
      ancestor.type.endsWith("Statement")
      || ancestor.type.endsWith("Declaration")
      || ancestor.type === "VariableDeclarator"
      || ancestor.type === "Property"
      || ancestor.type === "PropertyDefinition"
    ) return scan.source.slice(ancestor.start, ancestor.end).slice(0, EXCERPT_CHARS);
  }
  return scan.source.slice(node.start, node.end).slice(0, EXCERPT_CHARS);
}

function recordReference(scan: ReferenceScan, node: Node): void {
  // The candidate's own declaration never references itself as a caller.
  if (
    scan.isOwner
    && node.start >= scan.candidateStart
    && node.end <= scan.candidateEnd
  ) return;
  // The owner file's own export of the candidate (`export { fn }`,
  // `export default fn`) is the export mechanism, not a caller.
  if (scan.isOwner) {
    const ownExport = scan.ancestors.some((ancestor) =>
      ancestor.type === "ExportSpecifier" || ancestor.type === "ExportDefaultDeclaration"
    );
    if (ownExport) return;
  }
  scan.results.push({
    filePath: scan.filePath,
    call: excerptForReference(scan, node),
    arguments: [],
    line: lineAt(scan.source, node.start),
    kind: "reference",
  });
}

function readReferenceIdentifier(scan: ReferenceScan, node: Node): void {
  if (node.type !== "Identifier") return;
  const binding = resolveReferenceBinding(scan, node.name);
  if (binding?.kind !== "candidate" && binding?.kind !== "ownerImport") return;
  recordReference(scan, node);
}

/** `ns.fn` / `ns["fn"]` where `ns` is a namespace import of the owner
 * module: a value read of the candidate through the namespace object. */
function readNamespaceMember(scan: ReferenceScan, node: Node): boolean {
  if (node.type !== "MemberExpression") return false;
  const object = node.object;
  if (object.type !== "Identifier") return false;
  if (resolveReferenceBinding(scan, object.name)?.kind !== "namespace") return false;
  const property = node.property;
  if (node.computed) {
    if (property.type !== "Literal" || property.value !== scan.candidateName) return false;
  } else if (property.type !== "Identifier" || property.name !== scan.candidateName) {
    return false;
  }
  recordReference(scan, node);
  return true;
}

const PATTERN_LIKE_TYPES = new Set([
  "Identifier",
  "ObjectPattern",
  "ArrayPattern",
  "RestElement",
  "AssignmentPattern",
]);

/** Binding-pattern position: identifiers declare (shadowing the candidate
 * unless the pattern names the candidate's own declaration), while computed
 * keys and default values stay value positions and are walked as reads. */
function walkReferencePattern(
  scan: ReferenceScan,
  node: Node,
  declare: boolean,
  selfRange: { start: number; end: number } | undefined,
): void {
  switch (node.type) {
    case "Identifier": {
      if (declare) bindReferenceName(scan, node.name, selfRange?.start, selfRange?.end);
      return;
    }
    case "ObjectPattern": {
      for (const item of node.properties) {
        if (item.type === "Property") {
          if (item.computed) walkReferenceValue(scan, item.key);
          walkReferencePattern(scan, item.value, declare, selfRange);
        } else {
          walkReferencePattern(scan, item.argument, declare, selfRange);
        }
      }
      return;
    }
    case "ArrayPattern": {
      for (const element of node.elements) {
        if (element === null) continue;
        walkReferencePattern(scan, element, declare, selfRange);
      }
      return;
    }
    case "RestElement": {
      walkReferencePattern(scan, node.argument, declare, selfRange);
      return;
    }
    case "AssignmentPattern": {
      walkReferencePattern(scan, node.left, declare, selfRange);
      walkReferenceValue(scan, node.right);
      return;
    }
    case "TSParameterProperty": {
      if (PATTERN_LIKE_TYPES.has(node.parameter.type)) {
        walkReferencePattern(scan, node.parameter, declare, selfRange);
      } else {
        walkReferenceValue(scan, node.parameter);
      }
      return;
    }
    default: {
      // Exotic patterns: computed positions may still read the candidate, so
      // fall back to value walking.
      walkReferenceValue(scan, node);
    }
  }
}

function walkReferenceFunction(scan: ReferenceScan, node: Node, bindsIdInParent: boolean): void {
  if (
    node.type !== "FunctionDeclaration"
    && node.type !== "FunctionExpression"
    && node.type !== "ArrowFunctionExpression"
  ) return;
  const id = node.type === "ArrowFunctionExpression" ? undefined : node.id;
  if (bindsIdInParent && id !== null && id !== undefined && id.type === "Identifier") {
    bindReferenceName(scan, id.name, node.start, node.end);
  }
  scan.scopes.push(new Map());
  if (!bindsIdInParent && id !== null && id !== undefined && id.type === "Identifier") {
    // Named function expressions bind their own name inside themselves.
    bindReferenceName(scan, id.name, node.start, node.end);
  }
  for (const param of node.params) {
    walkReferencePattern(scan, param, true, undefined);
  }
  const body = node.body;
  if (body === null || body === undefined) {
    scan.scopes.pop();
    return;
  }
  if (body.type === "BlockStatement") {
    // Params and body share one function scope (hoisting ignored: see the
    // block-scoping note above).
    for (const statement of body.body) {
      // Directives carry no identifiers; they fall through to the statement
      // default below and die quietly on their string literal.
      walkReferenceStatement(scan, statement);
    }
  } else {
    walkReferenceValue(scan, body);
  }
  scan.scopes.pop();
}

function walkReferenceStatement(scan: ReferenceScan, node: Node): void {
  if (TYPE_SUBTREE_ROOTS.has(node.type)) return;
  scan.ancestors.push(node);
  try {
    switch (node.type) {
      case "VariableDeclaration": {
        if (node.declare === true) return;
        for (const declarator of node.declarations) {
          const init = declarator.init;
          // `const fn = () => ...` where the initializer IS the candidate:
          // the declarator id names the candidate itself, not a shadow.
          const selfRange = init !== null && init !== undefined
            && init.start === scan.candidateStart
            && init.end === scan.candidateEnd
            ? { start: init.start, end: init.end }
            : undefined;
          walkReferencePattern(scan, declarator.id, true, selfRange);
          if (init !== null && init !== undefined) walkReferenceValue(scan, init);
        }
        return;
      }
      case "FunctionDeclaration": {
        walkReferenceFunction(scan, node, true);
        return;
      }
      case "ClassDeclaration": {
        if (node.declare === true) return;
        const id = node.id;
        if (id !== null && id !== undefined && id.type === "Identifier") {
          bindReferenceName(scan, id.name, undefined, undefined);
        }
        walkReferenceClassTail(scan, node);
        return;
      }
      case "ImportDeclaration":
        // Bindings, not reads; seeds already carry the owner-import locals.
        return;
      case "ExportNamedDeclaration": {
        if (node.source) return;
        const declaration = node.declaration;
        if (declaration !== null && declaration !== undefined) {
          walkReferenceStatement(scan, declaration);
          return;
        }
        for (const specifier of node.specifiers) {
          // Walked as a whole so the specifier stays on the ancestor stack:
          // the owner file's own export of the candidate is the export
          // mechanism, not a caller (see recordReference).
          walkReferenceValue(scan, specifier);
        }
        return;
      }
      case "ExportDefaultDeclaration": {
        walkReferenceValue(scan, node.declaration);
        return;
      }
      case "ExportAllDeclaration":
        return;
      case "BlockStatement":
      case "StaticBlock": {
        scan.scopes.push(new Map());
        for (const statement of node.body) {
          walkReferenceStatement(scan, statement);
        }
        scan.scopes.pop();
        return;
      }
      case "ExpressionStatement": {
        walkReferenceValue(scan, node.expression);
        return;
      }
      case "IfStatement": {
        walkReferenceValue(scan, node.test);
        walkReferenceStatement(scan, node.consequent);
        const alternate = node.alternate;
        if (alternate !== null && alternate !== undefined) {
          walkReferenceStatement(scan, alternate);
        }
        return;
      }
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement": {
        scan.scopes.push(new Map());
        if (node.type === "ForStatement") {
          const init = node.init;
          if (init !== null && init !== undefined) {
            if (init.type === "VariableDeclaration") walkReferenceStatement(scan, init);
            else walkReferenceValue(scan, init);
          }
          const test = node.test;
          if (test !== null && test !== undefined) walkReferenceValue(scan, test);
          const update = node.update;
          if (update !== null && update !== undefined) walkReferenceValue(scan, update);
        } else {
          const left = node.left;
          if (left.type === "VariableDeclaration") {
            walkReferenceStatement(scan, left);
          } else if (left.type !== "Identifier") {
            // `for (target of ...)` / `for (target in ...)`: a write, not a
            // read, so patterns bind nothing and plain writes are skipped.
            walkReferencePattern(scan, left, false, undefined);
          }
          walkReferenceValue(scan, node.right);
        }
        walkReferenceStatement(scan, node.body);
        scan.scopes.pop();
        return;
      }
      case "WhileStatement":
      case "DoWhileStatement": {
        walkReferenceValue(scan, node.test);
        walkReferenceStatement(scan, node.body);
        return;
      }
      case "SwitchStatement": {
        walkReferenceValue(scan, node.discriminant);
        for (const clause of node.cases) {
          const test = clause.test;
          if (test !== null && test !== undefined) walkReferenceValue(scan, test);
          for (const statement of clause.consequent) {
            walkReferenceStatement(scan, statement);
          }
        }
        return;
      }
      case "TryStatement": {
        walkReferenceStatement(scan, node.block);
        const handler = node.handler;
        if (handler !== null && handler !== undefined) {
          scan.scopes.push(new Map());
          const param = handler.param;
          if (param !== null && param !== undefined) {
            walkReferencePattern(scan, param, true, undefined);
          }
          for (const statement of handler.body.body) {
            walkReferenceStatement(scan, statement);
          }
          scan.scopes.pop();
        }
        const finalizer = node.finalizer;
        if (finalizer !== null && finalizer !== undefined) {
          walkReferenceStatement(scan, finalizer);
        }
        return;
      }
      case "ReturnStatement":
      case "ThrowStatement": {
        const argument = node.argument;
        if (argument !== null && argument !== undefined) walkReferenceValue(scan, argument);
        return;
      }
      case "LabeledStatement": {
        walkReferenceStatement(scan, node.body);
        return;
      }
      case "BreakStatement":
      case "ContinueStatement":
      case "DebuggerStatement":
      case "EmptyStatement":
        return;
      default: {
        // Expressions in statement position and exotic statements: route
        // children through value walking (ambient declarations return early
        // via the type-subtree check above).
        for (const child of childNodes(node)) {
          walkReferenceValue(scan, child);
        }
      }
    }
  } finally {
    scan.ancestors.pop();
  }
}

function isCountedCallCallee(scan: ReferenceScan, parent: Node, node: Node): boolean {
  if (parent.type !== "CallExpression" || parent.callee !== node) return false;
  if (node.type === "Identifier") {
    return scan.isOwner ? node.name === scan.candidateName : scan.identifiers.has(node.name);
  }
  // `ns.fn(...)`: the call pass counts namespace member calls, so the
  // callee is owned there and skipped here.
  if (node.type === "MemberExpression" && node.computed !== true) {
    const object = node.object;
    const property = node.property;
    return object.type === "Identifier"
      && scan.namespaces.has(object.name)
      && property.type === "Identifier"
      && property.name === scan.candidateName;
  }
  return false;
}

function walkReferenceValue(scan: ReferenceScan, node: Node): void {
  if (TYPE_SUBTREE_ROOTS.has(node.type)) return;
  if (node.type === "Identifier") {
    const parent = scan.ancestors[scan.ancestors.length - 1];
    if (parent !== undefined && isCountedCallCallee(scan, parent, node)) return;
    readReferenceIdentifier(scan, node);
    return;
  }
  scan.ancestors.push(node);
  try {
    switch (node.type) {
      case "FunctionExpression":
      case "ArrowFunctionExpression": {
        walkReferenceFunction(scan, node, false);
        return;
      }
      case "FunctionDeclaration": {
        // Overload-style or nested declarations in expression walk: bind in
        // the current scope like a statement would.
        walkReferenceFunction(scan, node, true);
        return;
      }
      case "ClassExpression": {
        const id = node.id;
        if (id !== null && id !== undefined && id.type === "Identifier") {
          bindReferenceName(scan, id.name, undefined, undefined);
        }
        walkReferenceClassTail(scan, node);
        return;
      }
      case "VariableDeclaration":
      case "ClassDeclaration": {
        // Declarations nested in value walk (e.g. under `export default`):
        // the statement walker owns ancestor bookkeeping for these, so pop
        // the frame pushed above before delegating.
        scan.ancestors.pop();
        walkReferenceStatement(scan, node);
        scan.ancestors.push(node);
        return;
      }
      case "MemberExpression": {
        // Namespace reads (`ns.fn`) record through the member; counted-call
        // callees were already skipped by the CallExpression rule below, so a
        // member walked here is a genuine value read.
        if (!readNamespaceMember(scan, node)) {
          walkReferenceValue(scan, node.object);
          // Non-computed properties (`obj.fn`) name a slot, not the binding.
          if (node.computed) walkReferenceValue(scan, node.property);
        }
        return;
      }
      case "CallExpression": {
        if (!isCountedCallCallee(scan, node, node.callee)) {
          walkReferenceValue(scan, node.callee);
        }
        for (const argument of node.arguments) {
          walkReferenceValue(scan, argument);
        }
        return;
      }
      case "NewExpression": {
        // The call pass never visits NewExpression, so `new fn()` is a
        // reference here rather than a double count.
        walkReferenceValue(scan, node.callee);
        for (const argument of node.arguments) {
          walkReferenceValue(scan, argument);
        }
        return;
      }
      case "AssignmentExpression": {
        // Left-hand writes are not reads; member targets still read their
        // object (`fn.key = 1` reads `fn`).
        const left = node.left;
        if (left.type === "Identifier") {
          // Plain write: skip.
        } else if (left.type === "ObjectPattern" || left.type === "ArrayPattern") {
          walkReferencePattern(scan, left, false, undefined);
        } else {
          walkReferenceValue(scan, left);
        }
        walkReferenceValue(scan, node.right);
        return;
      }
      case "UpdateExpression":
        // `fn++` is neither a call nor reference-shaped use for this pass.
        return;
      case "Property": {
        if (node.computed) walkReferenceValue(scan, node.key);
        walkReferenceValue(scan, node.value);
        return;
      }
      case "PropertyDefinition": {
        if (node.computed) walkReferenceValue(scan, node.key);
        const value = node.value;
        if (value !== null && value !== undefined) walkReferenceValue(scan, value);
        return;
      }
      case "MethodDefinition": {
        if (node.computed) walkReferenceValue(scan, node.key);
        walkReferenceValue(scan, node.value);
        return;
      }
      case "ExportSpecifier": {
        walkReferenceValue(scan, node.local);
        return;
      }
      case "TSEnumMember": {
        // Member names are slots, not reads; initializers evaluate at runtime.
        const initializer = node.initializer;
        if (initializer !== null && initializer !== undefined) {
          walkReferenceValue(scan, initializer);
        }
        return;
      }
      case "JSXElement":
      case "JSXFragment":
        // Consistent with the call pass: JSX use is invisible to both passes.
        return;
      case "SpreadElement": {
        walkReferenceValue(scan, node.argument);
        return;
      }
      case "ChainExpression": {
        walkReferenceValue(scan, node.expression);
        return;
      }
      default:
        for (const child of childNodes(node)) {
          walkReferenceValue(scan, child);
        }
    }
  } finally {
    scan.ancestors.pop();
  }
}

function walkReferenceClassTail(scan: ReferenceScan, node: Node): void {
  if (node.type !== "ClassDeclaration" && node.type !== "ClassExpression") return;
  const superClass = node.superClass;
  if (superClass !== null && superClass !== undefined) walkReferenceValue(scan, superClass);
  for (const decorator of node.decorators ?? []) {
    walkReferenceValue(scan, decorator);
  }
  const body = node.body;
  if (body.type !== "ClassBody") return;
  for (const member of body.body) {
    if (member.type === "StaticBlock") {
      scan.scopes.push(new Map());
      for (const statement of member.body) {
        walkReferenceStatement(scan, statement);
      }
      scan.scopes.pop();
      continue;
    }
    if (
      member.type === "MethodDefinition"
      || member.type === "PropertyDefinition"
      || member.type === "AccessorProperty"
    ) {
      for (const decorator of member.decorators ?? []) {
        walkReferenceValue(scan, decorator);
      }
    }
    if (member.type === "MethodDefinition") {
      if (member.computed) walkReferenceValue(scan, member.key);
      walkReferenceValue(scan, member.value);
    } else if (member.type === "PropertyDefinition" || member.type === "AccessorProperty") {
      // Computed keys and runtime initializers read; plain keys do not.
      if (member.computed) walkReferenceValue(scan, member.key);
      const value = member.value;
      if (value !== null && value !== undefined) walkReferenceValue(scan, value);
    }
    // Other member shapes (index signatures) declare without reading; they
    // are ignored rather than walked.
  }
}

function collectFunctionReferences(
  ownerPath: string,
  functionName: string,
  candidateStart: number,
  candidateEnd: number,
  projectFiles: ProjectFile[],
): FunctionCaller[] {
  const result: FunctionCaller[] = [];
  for (const file of projectFiles) {
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const isOwner = file.filePath === ownerPath;
    const seed = new Map<string, ReferenceBinding>();
    let identifiers: Set<string>;
    let namespaces: Set<string>;
    if (isOwner) {
      seed.set(functionName, { kind: "candidate" });
      identifiers = new Set([functionName]);
      namespaces = new Set();
    } else {
      const names = importedCallNames(
        parsed.program,
        file.filePath,
        ownerPath,
        functionName,
        projectFiles,
      );
      if (names.identifiers.size === 0 && names.namespaces.size === 0) continue;
      for (const local of names.identifiers) seed.set(local, { kind: "ownerImport" });
      for (const local of names.namespaces) seed.set(local, { kind: "namespace" });
      identifiers = names.identifiers;
      namespaces = names.namespaces;
    }
    const scan: ReferenceScan = {
      source: file.source,
      filePath: file.filePath,
      isOwner,
      candidateName: functionName,
      candidateStart,
      candidateEnd,
      identifiers,
      namespaces,
      scopes: [seed],
      ancestors: [],
      results: [],
    };
    for (const statement of parsed.program.body) {
      walkReferenceStatement(scan, statement);
    }
    result.push(...scan.results);
  }
  return result;
}

export function findFunctionReferences(
  ownerPath: string,
  functionName: string,
  projectFiles: ProjectFile[],
  candidateRange: { start: number; end: number },
): FunctionCaller[] {
  return collectFunctionReferences(
    ownerPath,
    functionName,
    candidateRange.start,
    candidateRange.end,
    projectFiles,
  ).slice(0, 20);
}

/** Direct calls plus references-as-values, for the caller-evidence path
 * shared by the unused and single-caller exported-helper rules. Every other
 * `findFunctionCallers(WithCoverage)` consumer keeps the direct-call-only
 * matcher: change-stranded-code, complexity-displacement, divergent-change,
 * fragmented-stateful-procedure, overload-resolution-ambiguity,
 * positional-extension-drift, reentrant-entry, unmarked-abandoned-compat-layer,
 * unpinned-compat-quirk, unwieldy-signature, wide-fan-in-edit, and the
 * transitive test-pin walk in test-scope. */
export function findFunctionCallersAndReferencesWithCoverage(
  ownerPath: string,
  functionName: string,
  projectFiles: ProjectFile[],
  candidateRange: { start: number; end: number },
): FunctionCallersCoverage {
  const callers = collectFunctionCallers(ownerPath, functionName, projectFiles);
  const references = collectFunctionReferences(
    ownerPath,
    functionName,
    candidateRange.start,
    candidateRange.end,
    projectFiles,
  );
  const combined = [...callers, ...references];
  return { callers: combined, total: combined.length };
}

export type SeamCallSite = FunctionCaller & {
  /** Innermost enclosing named function in the caller file, or null at module
   * top level or under anonymous-only nesting (no nameable seam). */
  seam: string | null;
};

type NamedFunctionRange = {
  name: string;
  start: number;
  end: number;
};

function namedFunctionRanges(program: Program): NamedFunctionRange[] {
  const ranges: NamedFunctionRange[] = [];
  const declaratorBound = new Set<string>();
  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier") return;
      if (
        node.init?.type !== "ArrowFunctionExpression"
        && node.init?.type !== "FunctionExpression"
      ) return;
      ranges.push({ name: node.id.name, start: node.init.start, end: node.init.end });
      declaratorBound.add(`${node.init.start}:${node.init.end}`);
    },
    FunctionDeclaration(node) {
      if (node.id?.name === undefined) return;
      ranges.push({ name: node.id.name, start: node.start, end: node.end });
    },
    FunctionExpression(node) {
      if (node.id?.name === undefined) return;
      if (declaratorBound.has(`${node.start}:${node.end}`)) return;
      ranges.push({ name: node.id.name, start: node.start, end: node.end });
    },
  }).visit(program);
  return ranges;
}

function collectSeamCallSites(
  ownerPath: string,
  functionName: string,
  projectFiles: ProjectFile[],
): SeamCallSite[] {
  const result: SeamCallSite[] = [];
  for (const file of projectFiles) {
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const names = file.filePath === ownerPath
      ? { identifiers: new Set([functionName]), namespaces: new Set<string>() }
      : importedCallNames(
        parsed.program,
        file.filePath,
        ownerPath,
        functionName,
        projectFiles,
      );
    if (names.identifiers.size === 0 && names.namespaces.size === 0) continue;
    const seams = namedFunctionRanges(parsed.program);
    new Visitor({
      CallExpression(call) {
        if (!isMatchingCall(call, functionName, names.identifiers, names.namespaces)) return;
        let seam: string | null = null;
        let narrowest = Number.POSITIVE_INFINITY;
        for (const range of seams) {
          if (range.start <= call.start && range.end >= call.end) {
            const width = range.end - range.start;
            if (width < narrowest) {
              narrowest = width;
              seam = range.name;
            }
          }
        }
        result.push({
          filePath: file.filePath,
          call: file.source.slice(call.start, call.end),
          arguments: call.arguments.map((argument) => file.source.slice(argument.start, argument.end)),
          line: lineAt(file.source, call.start),
          seam,
        });
      },
    }).visit(parsed.program);
  }
  return result;
}

export function findSeamCallSites(
  ownerPath: string,
  functionName: string,
  projectFiles: ProjectFile[],
): SeamCallSite[] {
  return collectSeamCallSites(ownerPath, functionName, projectFiles).slice(0, 20);
}

export type AbstractionNode = TSInterfaceDeclaration | TSTypeAliasDeclaration;

export function findDirectAbstraction(
  program: Program,
  candidate: Candidate,
): AbstractionNode | undefined {
  let result: AbstractionNode | undefined;
  const matches = (node: AbstractionNode): void => {
    if (node.start === candidate.start && node.end === candidate.end) result = node;
  };
  new Visitor({
    TSInterfaceDeclaration: matches,
    TSTypeAliasDeclaration: matches,
  }).visit(program);
  return result;
}

export function abstractionName(_program: Program, node: AbstractionNode): string {
  return node.id.name;
}

export function isAbstractionExported(
  program: Program,
  node: AbstractionNode,
  name: string,
): boolean {
  for (const statement of program.body) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    if (statement.declaration === node) return true;
    if (statement.specifiers.some((specifier) => {
      const local = specifier.local;
      return local.type === "Identifier" && local.name === name;
    })) return true;
  }
  return false;
}

export type ModuleImporter = {
  filePath: string;
  importedSymbols: string[];
  source: string;
};

export function findModuleImporters(
  ownerPath: string,
  projectFiles: ProjectFile[],
): ModuleImporter[] {
  const result: ModuleImporter[] = [];
  for (const file of projectFiles) {
    if (file.filePath === ownerPath) continue;
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const symbols: string[] = [];
    for (const imported of moduleImports(parsed.program)) {
      const resolved = resolveModule(file.filePath, imported.source, projectFiles);
      if (
        resolved?.filePath !== ownerPath
        && !specifierTargetsOwner(file.filePath, imported.source, ownerPath)
      ) continue;
      if (!symbols.includes(imported.imported)) symbols.push(imported.imported);
    }
    if (symbols.length > 0) {
      result.push({
        filePath: file.filePath,
        importedSymbols: symbols,
        source: file.source.slice(0, 12_000),
      });
    }
  }
  return result.slice(0, 12);
}

export type ModuleMutableBinding = {
  name: string;
  kind: "let" | "var" | "const";
  start: number;
  end: number;
};

export function moduleMutableBindings(program: Program): ModuleMutableBinding[] {
  const bindings: ModuleMutableBinding[] = [];
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    if (declaration.kind !== "let" && declaration.kind !== "var" && declaration.kind !== "const") {
      continue;
    }
    for (const item of declaration.declarations) {
      if (item.id.type !== "Identifier") continue;
      if (declaration.kind === "const") {
        const init = item.init;
        if (
          init?.type !== "ObjectExpression"
          && init?.type !== "ArrayExpression"
          && init?.type !== "NewExpression"
        ) continue;
      }
      bindings.push({
        name: item.id.name,
        kind: declaration.kind,
        start: declaration.start,
        end: declaration.end,
      });
    }
  }
  return bindings;
}

export function calleeRootName(callee: CallExpression["callee"]): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression") {
    if (callee.object.type === "Super") return null;
    return memberObjectRoot(callee.object);
  }
  if (callee.type === "ChainExpression") {
    const chained = callee.expression;
    if (chained.type === "CallExpression") return calleeRootName(chained.callee);
    if (chained.type === "MemberExpression") {
      if (chained.object.type === "Super") return null;
      return memberObjectRoot(chained.object);
    }
  }
  return null;
}

function memberObjectRoot(object: Expression): string | null {
  if (object.type === "Identifier") return object.name;
  if (object.type === "MemberExpression") {
    if (object.object.type === "Super") return null;
    return memberObjectRoot(object.object);
  }
  if (object.type === "CallExpression") return calleeRootName(object.callee);
  return null;
}

export function findNamedFunction(
  program: Program,
  name: string,
): FunctionNode | undefined {
  let result: FunctionNode | undefined;
  new Visitor({
    FunctionDeclaration(node) {
      if (result === undefined && node.id?.name === name) result = node;
    },
    VariableDeclarator(node) {
      if (result !== undefined || node.id.type !== "Identifier" || node.id.name !== name) return;
      if (
        node.init?.type === "ArrowFunctionExpression"
        || node.init?.type === "FunctionExpression"
      ) result = node.init;
    },
  }).visit(program);
  return result;
}

const manifestDependencySection = z.record(z.string(), z.string());

const manifestSchema = z.object({
  dependencies: manifestDependencySection.optional(),
  devDependencies: manifestDependencySection.optional(),
  peerDependencies: manifestDependencySection.optional(),
  optionalDependencies: manifestDependencySection.optional(),
});

export type ManifestDependency = {
  name: string;
  section: string;
  version: string;
};

export function manifestDependencies(source: string): ManifestDependency[] {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    return [];
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) return [];
  const result: ManifestDependency[] = [];
  const sections = [
    { section: "dependencies", entries: parsed.data.dependencies },
    { section: "devDependencies", entries: parsed.data.devDependencies },
    { section: "peerDependencies", entries: parsed.data.peerDependencies },
    { section: "optionalDependencies", entries: parsed.data.optionalDependencies },
  ];
  for (const { section, entries } of sections) {
    if (!entries) continue;
    for (const [name, version] of Object.entries(entries)) {
      result.push({ name, section, version });
    }
  }
  return result;
}
