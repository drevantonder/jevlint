import { parseSync } from "oxc-parser";
import type { CallExpression, Expression, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

type TargetModuleEvidence = {
  filePath: string;
  source: string;
};

export type PassThroughWrapperEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  delegation: {
    call: string;
    targetRoot: string;
    importedFrom: string | null;
    ownership: "same-module" | "project-module" | "external-package" | "unresolved";
    targetModule: TargetModuleEvidence | null;
  };
  callers: FunctionCaller[];
};

function callExpression(expression: Expression): CallExpression | undefined {
  const unwrapped = expression.type === "AwaitExpression" ? expression.argument : expression;
  return unwrapped.type === "CallExpression" ? unwrapped : undefined;
}

function delegatedCall(node: FunctionNode): CallExpression | undefined {
  if (!node.body) return undefined;
  if (node.body.type !== "BlockStatement") return callExpression(node.body);
  if (node.body.body.length !== 1) return undefined;
  const statement = node.body.body[0];
  if (!statement || statement.type !== "ReturnStatement" || !statement.argument) return undefined;
  return callExpression(statement.argument);
}

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") return rootIdentifier(expression.object);
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  return undefined;
}

function hasTopLevelBinding(program: Program, name: string): boolean {
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (!declaration) continue;
    if (
      (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration")
      && declaration.id?.name === name
    ) return true;
    if (
      declaration.type === "VariableDeclaration"
      && declaration.declarations.some((item) => item.id.type === "Identifier" && item.id.name === name)
    ) return true;
  }
  return false;
}

export function buildPassThroughWrapperEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): PassThroughWrapperEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  const call = delegatedCall(fn);
  if (!call) return undefined;
  const targetRoot = rootIdentifier(call.callee);
  if (!targetRoot) return undefined;

  const importedTarget = moduleImports(parsed.program).find(({ local }) => local === targetRoot);
  const targetFile = importedTarget
    ? resolveModule(owner.filePath, importedTarget.source, projectFiles)
    : hasTopLevelBinding(parsed.program, targetRoot) ? owner : undefined;
  const ownership = importedTarget
    ? importedTarget.source.startsWith(".") ? "project-module" : "external-package"
    : targetFile ? "same-module" : "unresolved";

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    delegation: {
      call: owner.source.slice(call.start, call.end),
      targetRoot,
      importedFrom: importedTarget?.source ?? null,
      ownership,
      targetModule: targetFile
        ? { filePath: targetFile.filePath, source: targetFile.source.slice(0, 12_000) }
        : null,
    },
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
