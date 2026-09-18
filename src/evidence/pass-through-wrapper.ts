import { parseCached } from "./parse-cache.js";
import type { Argument, CallExpression, Expression, Program } from "oxc-parser";
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

type ArgumentFeatures = {
  callback: boolean;
  nestedCall: boolean;
  constructed: boolean;
};

type ForwardingEvidence = {
  receiverParameter: string | null;
  forwardedParameters: string[];
  directParameterForwarding: boolean;
  hasCallbackArgument: boolean;
  hasNestedCallArgument: boolean;
  hasConstructedArgument: boolean;
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
    targetType: string | null;
    importedFrom: string | null;
    ownership: "same-module" | "project-module" | "external-package" | "unresolved";
    targetModule: TargetModuleEvidence | null;
    forwarding: ForwardingEvidence;
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

function bindingName(parameter: FunctionNode["params"][number]): string | undefined {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  if (value.type === "Identifier") return value.name;
  if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
    return value.left.name;
  }
  if (value.type === "RestElement" && value.argument.type === "Identifier") {
    return value.argument.name;
  }
  return undefined;
}

function argumentFeatures(argument: Argument): ArgumentFeatures {
  if (argument.type === "ArrowFunctionExpression" || argument.type === "FunctionExpression") {
    return { callback: true, nestedCall: false, constructed: false };
  }
  if (argument.type === "SpreadElement") return argumentFeatures(argument.argument);
  if (argument.type === "ChainExpression") return argumentFeatures(argument.expression);
  if (argument.type === "CallExpression" || argument.type === "NewExpression") {
    const nested = argument.arguments.map(argumentFeatures);
    return {
      callback: nested.some(({ callback }) => callback),
      nestedCall: argument.type === "CallExpression"
        || nested.some(({ nestedCall }) => nestedCall),
      constructed: argument.type === "NewExpression"
        || nested.some(({ constructed }) => constructed),
    };
  }
  return { callback: false, nestedCall: false, constructed: false };
}

function forwardingEvidence(
  fn: FunctionNode,
  call: CallExpression,
  targetRoot: string,
): ForwardingEvidence {
  const parameters = fn.params.flatMap((parameter) => {
    const name = bindingName(parameter);
    return name === undefined ? [] : [name];
  });
  const receiverParameter = parameters.includes(targetRoot) ? targetRoot : null;
  const expectedForwarding = parameters.filter((name) => name !== receiverParameter);
  const forwardedParameters = call.arguments.flatMap((argument) =>
    argument.type === "Identifier" ? [argument.name] : []
  );
  const features = call.arguments.map(argumentFeatures);
  const hasCallbackArgument = features.some(({ callback }) => callback);
  const hasNestedCallArgument = features.some(({ nestedCall }) => nestedCall);
  const hasConstructedArgument = features.some(({ constructed }) => constructed);
  return {
    receiverParameter,
    forwardedParameters,
    directParameterForwarding: call.arguments.length === expectedForwarding.length
      && forwardedParameters.length === expectedForwarding.length
      && forwardedParameters.every((name, index) => name === expectedForwarding[index]),
    hasCallbackArgument,
    hasNestedCallArgument,
    hasConstructedArgument,
  };
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

function topLevelTypeSource(
  program: Program,
  name: string,
  ownerSource: string,
): string | undefined {
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (
      (declaration?.type === "TSInterfaceDeclaration"
        || declaration?.type === "TSTypeAliasDeclaration")
      && declaration.id.name === name
    ) return ownerSource.slice(declaration.start, declaration.end);
  }
  return undefined;
}

function parameterTypeName(
  fn: FunctionNode,
  targetRoot: string,
  ownerSource: string,
): string | undefined {
  const typePattern = new RegExp(`^${targetRoot}\\s*:\\s*([A-Za-z_$][\\w$]*)`);
  for (const parameter of fn.params) {
    const match = typePattern.exec(ownerSource.slice(parameter.start, parameter.end).trim());
    if (match?.[1]) return match[1];
  }
  return undefined;
}

export function buildPassThroughWrapperEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): PassThroughWrapperEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  const call = delegatedCall(fn);
  if (!call) return undefined;
  const targetRoot = rootIdentifier(call.callee);
  if (!targetRoot) return undefined;

  const imports = moduleImports(parsed.program);
  const importedTarget = imports.find(({ local }) => local === targetRoot);
  const targetTypeName = parameterTypeName(fn, targetRoot, owner.source);
  const importedTargetType = targetTypeName === undefined
    ? undefined
    : imports.find(({ local }) => local === targetTypeName);
  const targetImport = importedTarget ?? importedTargetType;
  const localTargetTypeSource = targetTypeName === undefined
    ? undefined
    : topLevelTypeSource(parsed.program, targetTypeName, owner.source);
  const targetFile = targetImport
    ? resolveModule(owner.filePath, targetImport.source, projectFiles)
    : hasTopLevelBinding(parsed.program, targetRoot) || localTargetTypeSource !== undefined
      ? owner
      : undefined;
  const ownership = targetImport
    ? targetImport.source.startsWith(".") ? "project-module" : "external-package"
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
      targetType: targetTypeName ?? null,
      importedFrom: targetImport?.source ?? null,
      ownership,
      targetModule: targetFile
        ? {
            filePath: targetFile.filePath,
            source: localTargetTypeSource ?? targetFile.source.slice(0, 12_000),
          }
        : null,
      forwarding: forwardingEvidence(fn, call, targetRoot),
    },
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
