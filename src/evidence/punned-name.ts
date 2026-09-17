import { parseSync, Visitor } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type PunnedSignature = {
  filePath: string;
  parameterCount: number;
  parameterTypes: string[];
  returnType: string | null;
  source: string;
};

export type PunnedNameEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  signature: PunnedSignature;
  siblings: PunnedSignature[];
  callers: FunctionCaller[];
};

function parameterTypeText(
  parameter: FunctionNode["params"][number],
  source: string,
): string {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  const identifier = value.type === "AssignmentPattern" && value.left.type === "Identifier"
    ? value.left
    : value.type === "Identifier"
      ? value
      : null;
  if (identifier?.typeAnnotation) {
    return source
      .slice(identifier.typeAnnotation.start, identifier.typeAnnotation.end)
      .replace(/^:\s*/, "")
      .trim()
      .toLowerCase()
      .slice(0, 80);
  }
  return value.type === "AssignmentPattern" ? "defaulted" : value.type === "RestElement" ? "rest" : "untyped";
}

function returnTypeOf(node: FunctionNode, source: string): string | null {
  if (node.params.length === 0 || !node.body) {
    const between = source.slice(node.start, node.body?.start ?? node.end);
    const match = /\)\s*:\s*(.+?)\s*$/.exec(between.trim());
    return match?.[1]?.trim().toLowerCase().slice(0, 80) ?? null;
  }
  const last = node.params[node.params.length - 1];
  if (!last || !node.body) return null;
  const between = source.slice(last.end, node.body.start);
  const match = /\)\s*:\s*(.+?)\s*$/.exec(between.trim());
  return match?.[1]?.trim().toLowerCase().slice(0, 80) ?? null;
}

function signatureOf(node: FunctionNode, filePath: string, source: string): PunnedSignature {
  return {
    filePath,
    parameterCount: node.params.length,
    parameterTypes: node.params.map((parameter) => parameterTypeText(parameter, source)),
    returnType: returnTypeOf(node, source),
    source: source.slice(node.start, node.end).slice(0, 600),
  };
}

function signatureKey(signature: PunnedSignature): string {
  return `${signature.parameterCount}|${signature.parameterTypes.join(",")}|${signature.returnType ?? ""}`;
}

export function buildPunnedNameEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): PunnedNameEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const signature = signatureOf(fn, owner.filePath, owner.source);
  const key = signatureKey(signature);
  const siblings: PunnedSignature[] = [];

  for (const file of projectFiles) {
    if (siblings.length >= 10) break;
    const fileParsed = file.filePath === owner.filePath
      ? parsed
      : parseSync(file.filePath, file.source, { range: true });
    if (fileParsed.errors.some((error) => error.severity === "Error")) continue;
    const visit = (node: FunctionNode): void => {
      if (siblings.length >= 10) return;
      if (file.filePath === owner.filePath && node.start === candidate.start && node.end === candidate.end) {
        return;
      }
      const sibling = signatureOf(node, file.filePath, file.source);
      if (signatureKey(sibling) !== key) siblings.push(sibling);
    };
    new Visitor({
      FunctionDeclaration(node) {
        if (node.id?.name === name) visit(node);
      },
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier" || node.id.name !== name) return;
        if (node.init?.type === "ArrowFunctionExpression" || node.init?.type === "FunctionExpression") {
          visit(node.init);
        }
      },
    }).visit(fileParsed.program);
  }

  if (siblings.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    signature,
    siblings,
    callers: findFunctionCallers(owner.filePath, name, projectFiles),
  };
}
