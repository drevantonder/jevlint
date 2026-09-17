import { parseSync, Visitor } from "oxc-parser";
import type { Expression, Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type PhantomAccess = {
  path: string;
  root: string;
  importedFrom: string;
  ownerFile: string | null;
  memberFound: boolean;
  ownerHasReexport: boolean;
  ownerLooksDynamic: boolean;
};

export type PhantomMemberAccessEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  accesses: PhantomAccess[];
  siblingMemberUses: string[];
  repository: {
    callers: FunctionCaller[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") return rootIdentifier(expression.object);
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  return undefined;
}

function memberPath(expression: Expression, source: string): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "ChainExpression") return memberPath(expression.expression, source);
  if (expression.type !== "MemberExpression") return undefined;
  const object = memberPath(expression.object, source);
  if (object === undefined) return undefined;
  const property = expression.property.type === "Identifier"
    ? expression.property.name
    : expression.computed
      ? nodeSource(expression.property, source)
      : undefined;
  if (property === undefined) return undefined;
  return `${object}.${property}`;
}

function calleeExpression(node: Node): Expression | undefined {
  if (node.type === "CallExpression") return node.callee;
  return undefined;
}

function collectDeclaredNames(source: string, filePath: string) {
  const names = new Set<string>();
  const parsed = parseSync(filePath, source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) {
    return { names, hasReexport: false };
  }
  let hasReexport = false;
  for (const statement of parsed.program.body) {
    if (
      statement.type === "ExportAllDeclaration"
      || (statement.type === "ExportNamedDeclaration" && statement.source)
    ) {
      hasReexport = true;
    }
    if (statement.type === "ExportNamedDeclaration") {
      for (const specifier of statement.specifiers) {
        if (specifier.exported.type === "Identifier") names.add(specifier.exported.name);
      }
      const declaration = statement.declaration;
      if (
        declaration?.type === "FunctionDeclaration"
        || declaration?.type === "ClassDeclaration"
      ) {
        if (declaration.id?.name) names.add(declaration.id.name);
      }
      if (declaration?.type === "VariableDeclaration") {
        for (const item of declaration.declarations) {
          if (item.id.type === "Identifier") names.add(item.id.name);
        }
      }
    }
    if (statement.type === "ExportDefaultDeclaration") {
      names.add("default");
    }
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (
      declaration?.type === "FunctionDeclaration"
      || declaration?.type === "ClassDeclaration"
    ) {
      if (declaration.id?.name) names.add(declaration.id.name);
    }
    if (declaration?.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (item.id.type === "Identifier") names.add(item.id.name);
      }
    }
    if (
      declaration?.type === "ClassDeclaration" || declaration?.type === "ClassExpression"
    ) {
      for (const element of declaration.body.body) {
        if (
          (element.type === "MethodDefinition" || element.type === "PropertyDefinition")
          && element.key.type === "Identifier"
        ) names.add(element.key.name);
      }
    }
  }
  return { names, hasReexport };
}

export function buildPhantomMemberAccessEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): PhantomMemberAccessEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseSync(ownerFile.filePath, ownerFile.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const imports = moduleImports(parsed.program);
  const importedLocals = new Map(imports.map((entry) => [entry.local, entry]));
  if (importedLocals.size === 0) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const paths = new Map<string, Expression>();
  const visitExpression = (expression: Expression): void => {
    if (
      expression.type !== "MemberExpression"
      && expression.type !== "ChainExpression"
    ) return;
    const root = rootIdentifier(expression);
    if (root === undefined || !importedLocals.has(root)) return;
    const path = memberPath(expression, ownerFile.source);
    if (path === undefined || path === root) return;
    if (!paths.has(path)) paths.set(path, expression);
  };
  new Visitor({
    MemberExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      visitExpression(node);
    },
    CallExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const callee = calleeExpression(node);
      if (callee) visitExpression(callee);
    },
  }).visit(parsed.program);

  if (paths.size === 0) return undefined;

  const siblingMemberUses = new Set<string>();
  for (const file of projectFiles) {
    if (file.filePath === candidate.filePath) continue;
    for (const entry of imports) {
      const pattern = new RegExp(`\\b${entry.local.replace(/\$/g, "\\$")}\\.([A-Za-z_$][\\w$]*)`, "g");
      for (const match of file.source.matchAll(pattern)) {
        if (match[1]) siblingMemberUses.add(`${entry.local}.${match[1]}`);
      }
    }
  }

  const accesses: PhantomAccess[] = [];
  for (const [path, node] of paths) {
    const root = rootIdentifier(node) ?? "";
    const entry = importedLocals.get(root);
    if (!entry) continue;
    const owner = entry.source.startsWith(".")
      ? resolveModule(ownerFile.filePath, entry.source, projectFiles)
      : undefined;
    const member = path.split(".").at(-1) ?? "";
    let memberFound = false;
    let ownerHasReexport = false;
    let ownerLooksDynamic = false;
    if (owner) {
      const { names, hasReexport } = collectDeclaredNames(owner.source, owner.filePath);
      const tokenPattern = new RegExp(`\\b${member.replace(/\$/g, "\\$")}\\b`);
      memberFound = names.has(member) || tokenPattern.test(owner.source);
      ownerHasReexport = hasReexport;
      ownerLooksDynamic = owner.source.includes(": any")
        || owner.source.includes("as any")
        || owner.source.includes("Record<string, any>");
    }
    accesses.push({
      path,
      root,
      importedFrom: entry.source,
      ownerFile: owner?.filePath ?? null,
      memberFound,
      ownerHasReexport,
      ownerLooksDynamic,
    });
  }

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    accesses,
    siblingMemberUses: [...siblingMemberUses].slice(0, 20),
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
    },
  };
}
