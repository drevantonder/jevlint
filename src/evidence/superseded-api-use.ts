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
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";

export type SupersededUse = {
  path: string;
  importedFrom: string;
  ownerFile: string | null;
  deprecated: boolean;
  deprecationNote: string | null;
  successor: string | null;
  siblingSuccessorFiles: string[];
};

export type SupersededApiUseEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  uses: SupersededUse[];
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

function deprecationNoteNear(source: string, member: string): string | null {
  const declaration = new RegExp(
    `(?:function\\s+${member.replace(/\$/g, "\\$")}\\b|(?:const|let|var|class)\\s+${member.replace(/\$/g, "\\$")}\\b)`,
    "g",
  );
  for (const match of source.matchAll(declaration)) {
    const window = source.slice(Math.max(0, (match.index ?? 0) - 500), match.index ?? 0);
    const tagIndex = window.lastIndexOf("@deprecated");
    if (tagIndex === -1) continue;
    const between = window.slice(tagIndex);
    if (/(?:function|const|let|var|class)\s+[A-Za-z_$][\w$]*/.test(between.replace(/@deprecated[^\n*]*/, ""))) {
      continue;
    }
    const tag = /@deprecated[^\n*]*/.exec(window.slice(tagIndex));
    if (tag) return tag[0].trim().slice(0, 200);
  }
  return null;
}

function successorFromNote(note: string): string | null {
  const match = /\buse\s+([A-Za-z_$][\w$.]*)/i.exec(note);
  return match?.[1] ?? null;
}

function siblingSuccessorFiles(
  local: string,
  successor: string,
  ownerPath: string,
  projectFiles: ProjectFile[],
): string[] {
  const leaf = successor.split(".").pop() ?? successor;
  const pattern = new RegExp(`\\b${local.replace(/\$/g, "\\$")}\\s*\\.\\s*${leaf.replace(/\$/g, "\\$")}\\b`);
  return projectFiles
    .filter((file) => file.filePath !== ownerPath && pattern.test(file.source))
    .map((file) => file.filePath)
    .slice(0, 10);
}

export function buildSupersededApiUseEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): SupersededApiUseEvidence | undefined {
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
    if (expression.type !== "MemberExpression" && expression.type !== "ChainExpression") return;
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
      const callee = node.type === "CallExpression" ? node.callee : undefined;
      if (callee) visitExpression(callee);
    },
  }).visit(parsed.program);

  if (paths.size === 0) return undefined;

  const uses: SupersededUse[] = [];
  for (const [path, node] of paths) {
    const root = rootIdentifier(node) ?? "";
    const entry = importedLocals.get(root);
    if (!entry) continue;
    const owner = entry.source.startsWith(".")
      ? resolveModule(ownerFile.filePath, entry.source, projectFiles)
      : undefined;
    const member = path.split(".").at(-1) ?? "";
    const note = owner ? deprecationNoteNear(owner.source, member) : null;
    const successor = note ? successorFromNote(note) : null;
    uses.push({
      path,
      importedFrom: entry.source,
      ownerFile: owner?.filePath ?? null,
      deprecated: note !== null,
      deprecationNote: note,
      successor,
      siblingSuccessorFiles: successor
        ? siblingSuccessorFiles(root, successor, candidate.filePath, projectFiles)
        : [],
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
    uses: uses.slice(0, 15),
  };
}
