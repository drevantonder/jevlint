import { parseCached } from "./parse-cache.js";
import type { CallExpression, Expression, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type { FunctionNode } from "./repository.js";

export type ChainHop = {
  name: string;
  filePath: string;
  call: string;
  forwardedArgs: string[];
  renames: string[];
  addedDefaults: string[];
  awaited: boolean;
};

export type HollowDelegationChainEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  hops: ChainHop[];
  chainLength: number;
  finalTarget: string;
  endToEnd: {
    entryParams: string[];
    addedDefaults: string[];
  };
};

const MAX_HOPS = 8;

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

function unwrapCall(expression: Expression): { call: CallExpression; awaited: boolean } | undefined {
  const unwrapped = expression.type === "AwaitExpression" ? expression.argument : expression;
  if (unwrapped.type !== "CallExpression") return undefined;
  return { call: unwrapped, awaited: expression.type === "AwaitExpression" };
}

function singleForwardCall(node: FunctionNode): { call: CallExpression; awaited: boolean } | undefined {
  if (!node.body) return undefined;
  if (node.body.type !== "BlockStatement") return unwrapCall(node.body);
  if (node.body.body.length !== 1) return undefined;
  const statement = node.body.body[0];
  if (!statement || statement.type !== "ReturnStatement" || !statement.argument) return undefined;
  return unwrapCall(statement.argument);
}

function findTopLevelFunction(program: Program, name: string): FunctionNode | undefined {
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement.type === "ExportDefaultDeclaration"
        ? statement.declaration
        : statement;
    if (!declaration) continue;
    if (
      (declaration.type === "FunctionDeclaration" || declaration.type === "FunctionExpression")
      && declaration.id?.name === name
    ) return declaration;
    if (declaration.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (
          item.id.type === "Identifier"
          && item.id.name === name
          && (item.init?.type === "ArrowFunctionExpression" || item.init?.type === "FunctionExpression")
        ) return item.init;
      }
    }
  }
  return undefined;
}

type ResolvedFunction = {
  node: FunctionNode;
  program: Program;
  source: string;
  filePath: string;
};

function resolveFunction(
  name: string,
  ownerPath: string,
  ownerProgram: Program,
  projectFiles: ProjectFile[],
): ResolvedFunction | undefined {
  const owner = projectFiles.find((file) => file.filePath === ownerPath);
  if (!owner) return undefined;
  const local = findTopLevelFunction(ownerProgram, name);
  if (local) return { node: local, program: ownerProgram, source: owner.source, filePath: ownerPath };
  for (const imported of moduleImports(ownerProgram)) {
    if (imported.local !== name) continue;
    const target = resolveModule(ownerPath, imported.source, projectFiles);
    if (!target) return undefined;
    const parsed = parseCached(target.filePath, target.source);
    if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
    const targetNode = findTopLevelFunction(
      parsed.program,
      imported.imported === "default" ? name : imported.imported,
    );
    if (!targetNode) return undefined;
    return { node: targetNode, program: parsed.program, source: target.source, filePath: target.filePath };
  }
  return undefined;
}

export function buildHollowDelegationChainEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HollowDelegationChainEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const entry = findDirectFunction(parsed.program, candidate);
  if (!entry) return undefined;

  const hops: ChainHop[] = [];
  const visited = new Set<string>([`${owner.filePath}:${functionName(parsed.program, entry) ?? "<entry>"}`]);
  let current: FunctionNode = entry;
  let currentPath = owner.filePath;
  let currentProgram = parsed.program;
  let currentSource = owner.source;
  let finalTarget = "";
  let currentName = functionName(parsed.program, entry) ?? "<entry>";

  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const forward = singleForwardCall(current);
    if (!forward) {
      if (hop === 0) return undefined;
      break;
    }
    if (forward.call.callee.type !== "Identifier") {
      if (hop === 0) return undefined;
      break;
    }
    const targetName = forward.call.callee.name;
    const params = current.params.flatMap((parameter) => {
      const name = bindingName(parameter);
      return name === undefined ? [] : [name];
    });
    const paramSet = new Set(params);
    const forwardedArgs: string[] = [];
    const addedDefaults: string[] = [];
    for (const argument of forward.call.arguments) {
      if (argument.type === "Identifier" && paramSet.has(argument.name)) {
        forwardedArgs.push(argument.name);
      } else if (
        argument.type === "SpreadElement"
        && argument.argument.type === "Identifier"
        && paramSet.has(argument.argument.name)
      ) {
        forwardedArgs.push(`...${argument.argument.name}`);
      } else {
        addedDefaults.push(currentSource.slice(argument.start, argument.end).slice(0, 80));
      }
    }

    const resolved = resolveFunction(targetName, currentPath, currentProgram, projectFiles);
    if (!resolved) return undefined;
    if (resolved.filePath !== candidate.filePath) return undefined;
    const visitKey = `${resolved.filePath}:${targetName}`;
    if (visited.has(visitKey)) return undefined;
    visited.add(visitKey);

    const targetParams = resolved.node.params.flatMap((parameter) => {
      const name = bindingName(parameter);
      return name === undefined ? [] : [name];
    });
    const renames: string[] = [];
    forwardedArgs.forEach((arg, index) => {
      if (arg.startsWith("...")) return;
      const targetParam = targetParams[index];
      if (targetParam !== undefined && targetParam !== arg) renames.push(`${arg}->${targetParam}`);
    });

    const hopName = hop === 0
      ? (functionName(currentProgram, current) ?? "<entry>")
      : targetName;
    void hopName;
    hops.push({
      name: currentName,
      filePath: currentPath,
      call: currentSource.slice(forward.call.start, forward.call.end).slice(0, 200),
      forwardedArgs,
      renames,
      addedDefaults: addedDefaults.slice(0, 5),
      awaited: forward.awaited,
    });
    finalTarget = targetName;
    currentName = targetName;

    const nextForward = singleForwardCall(resolved.node);
    if (!nextForward) break;
    current = resolved.node;
    currentPath = resolved.filePath;
    currentProgram = resolved.program;
    currentSource = resolved.source;
  }

  if (hops.length < 3) return undefined;

  const entryName = functionName(parsed.program, entry);
  return {
    function: {
      name: entryName ?? null,
      exported: entryName ? isFunctionExported(parsed.program, entry, entryName) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    hops,
    chainLength: hops.length,
    finalTarget,
    endToEnd: {
      entryParams: entry.params.flatMap((parameter) => {
        const name = bindingName(parameter);
        return name === undefined ? [] : [name];
      }),
      addedDefaults: hops.flatMap((hop) => hop.addedDefaults).slice(0, 5),
    },
  };
}
