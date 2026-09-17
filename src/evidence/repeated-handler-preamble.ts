import { parseSync, Visitor } from "oxc-parser";
import type { Node, Program, Statement } from "oxc-parser";
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
} from "./repository.js";
import type { FunctionNode } from "./repository.js";

export type PreambleMatch = {
  sibling: string;
  fingerprint: string;
};

export type RepeatedHandlerPreambleEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  preamble: {
    fingerprint: string;
    statements: string[];
  };
  repetitions: PreambleMatch[];
  sharedHelpers: string[];
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function isPreambleStatement(statement: Statement): boolean {
  if (statement.type === "IfStatement") {
    const exits = (node: Statement): boolean =>
      node.type === "ReturnStatement"
      || node.type === "ThrowStatement"
      || (node.type === "BlockStatement"
        && node.body.some((item) => item.type === "ReturnStatement" || item.type === "ThrowStatement"));
    return exits(statement.consequent);
  }
  return statement.type === "TryStatement";
}

function normalizePreamble(text: string): string {
  return text
    .replace(/\b[A-Za-z_$][\w$]*\b(?=\s*\()/g, "CALL")
    .replace(/\b[A-Za-z_$][\w$]*\b/g, "?")
    .replace(/\s+/g, " ")
    .trim();
}

function fingerprintOf(statements: Statement[], source: string) {
  const texts = statements.map((statement) => nodeSource(statement, source));
  const fingerprint = texts.map(normalizePreamble).join(" || ");
  return { fingerprint, texts };
}

function leadingPreamble(
  fn: FunctionNode,
  source: string,
): { fingerprint: string; texts: string[] } | undefined {
  if (!fn.body || fn.body.type !== "BlockStatement") return undefined;
  const leading = fn.body.body.filter(isPreambleStatement).slice(0, 3);
  if (leading.length === 0) return undefined;
  return fingerprintOf(leading, source);
}

function siblingFunctions(
  program: Program,
  owner: FunctionNode,
  source: string,
): { name: string; fingerprint: string }[] {
  const result: { name: string; fingerprint: string }[] = [];
  const consider = (node: FunctionNode, name: string): void => {
    if (node === owner) return;
    if (containsNode(owner, node) || containsNode(node, owner)) return;
    const preamble = leadingPreamble(node, source);
    if (!preamble) return;
    result.push({ name, fingerprint: preamble.fingerprint });
  };
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.id?.name) {
      consider(declaration, declaration.id.name);
    }
    if (declaration?.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (
          item.id.type === "Identifier"
          && (item.init?.type === "ArrowFunctionExpression"
            || item.init?.type === "FunctionExpression")
        ) consider(item.init, item.id.name);
      }
    }
  }
  return result;
}

export function buildRepeatedHandlerPreambleEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): RepeatedHandlerPreambleEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseSync(ownerFile.filePath, ownerFile.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const preamble = leadingPreamble(fn, ownerFile.source);
  if (!preamble) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const handledCalls = new Set<string>();
  new Visitor({
    CallExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.callee.type === "Identifier") handledCalls.add(node.callee.name);
      if (
        node.callee.type === "MemberExpression"
        && node.callee.property.type === "Identifier"
      ) handledCalls.add(node.callee.property.name);
    },
  }).visit(parsed.program);

  const importedLocals = new Set(moduleImports(parsed.program).map((entry) => entry.local));
  const sharedHelpers = [...handledCalls].filter((name) => importedLocals.has(name)).slice(0, 10);

  const repetitions = siblingFunctions(parsed.program, fn, ownerFile.source)
    .filter(({ fingerprint }) => fingerprint === preamble.fingerprint)
    .map(({ name, fingerprint }): PreambleMatch => ({ sibling: name, fingerprint }))
    .slice(0, 10);

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    preamble: {
      fingerprint: preamble.fingerprint,
      statements: preamble.texts,
    },
    repetitions,
    sharedHelpers,
  };
}
