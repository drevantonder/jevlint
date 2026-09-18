import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, containsNode, nestedFunctionRanges } from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findModuleImporters,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type PlumbedParam = {
  name: string;
  forwardedTo: string[];
  downstreamParamMatch: boolean;
};

export type TransitivePlumbingEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    publicBoundary: boolean;
    filePath: string;
    source: string;
  };
  plumbedParams: PlumbedParam[];
  chainDepth: number;
  sameNameForwarders: string[];
  repository: {
    callers: FunctionCaller[];
    sameNamePassThrough: string[];
  };
};

const MAX_PROJECT_FILES = 30;

type ForwarderTally = {
  count: number;
  passThrough: string[];
};

function simpleParamNames(fn: FunctionNode): string[] {
  const names: string[] = [];
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    if (value.type === "Identifier") names.push(value.name);
  }
  return names;
}

function calleeName(callee: CallExpression["callee"]): string | undefined {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  return undefined;
}

function usesOf(
  program: Program,
  fn: FunctionNode,
  name: string,
): { range: NodeRange; forwarded: boolean }[] {
  const callArgRanges: NodeRange[] = [];
  new Visitor({
    CallExpression(node) {
      if (!containsNode(fn, node)) return;
      for (const argument of node.arguments) {
        const value = argument.type === "SpreadElement" ? argument.argument : argument;
        if (value.type === "Identifier" && value.name === name) {
          callArgRanges.push({ start: value.start, end: value.end });
        }
      }
    },
  }).visit(program);

  const excluded: NodeRange[] = fn.params.map((parameter) => ({
    start: parameter.start,
    end: parameter.end,
  }));
  new Visitor({
    MemberExpression(node) {
      if (!containsNode(fn, node)) return;
      if (!node.computed && node.property.type === "Identifier") {
        excluded.push({ start: node.property.start, end: node.property.end });
      }
    },
  }).visit(program);

  const uses: { range: NodeRange; forwarded: boolean }[] = [];
  new Visitor({
    Identifier(node) {
      if (node.name !== name) return;
      if (!containsNode(fn, node)) return;
      const range = { start: node.start, end: node.end };
      if (excluded.some((item) => item.start <= range.start && item.end >= range.end)) return;
      const forwarded = callArgRanges.some(
        (item) => item.start <= range.start && item.end >= range.end,
      );
      uses.push({ range, forwarded });
    },
  }).visit(program);
  return uses;
}

function forwardedCallees(
  program: Program,
  fn: FunctionNode,
  name: string,
): string[] {
  const callees: string[] = [];
  const nested = nestedFunctionRanges(program, fn);
  new Visitor({
    CallExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const target = calleeName(node.callee);
      if (!target) return;
      for (const argument of node.arguments) {
        const value = argument.type === "SpreadElement" ? argument.argument : argument;
        if (value.type === "Identifier" && value.name === name && !callees.includes(target)) {
          callees.push(target);
        }
      }
    },
  }).visit(program);
  return callees.slice(0, 10);
}

function isForwardOnly(program: Program, fn: FunctionNode, name: string): boolean {
  const uses = usesOf(program, fn, name);
  if (uses.length === 0) return false;
  return uses.every((use) => use.forwarded);
}

function declaredFunctionNames(program: Program, paramName: string): string[] {
  const names: string[] = [];
  new Visitor({
    FunctionDeclaration(node) {
      const params = node.params.flatMap((parameter) => {
        const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
        return value.type === "Identifier" ? [value.name] : [];
      });
      if (params.includes(paramName) && node.id?.name) names.push(node.id.name);
    },
    VariableDeclarator(node) {
      if (
        node.id.type !== "Identifier"
        || (node.init?.type !== "ArrowFunctionExpression" && node.init?.type !== "FunctionExpression")
      ) return;
      const params = node.init.params.flatMap((parameter) => {
        const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
        return value.type === "Identifier" ? [value.name] : [];
      });
      if (params.includes(paramName)) names.push(node.id.name);
    },
  }).visit(program);
  return names;
}

function matchForwardOnlyInFile(
  program: Program,
  filePath: string,
  ownerPath: string,
  paramName: string,
  candidate: { start: number; end: number },
  forwarders: ForwarderTally,
): void {
  const matches = (node: FunctionNode): void => {
    const params = node.params.flatMap((parameter) => {
      const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
      return value.type === "Identifier" ? [value.name] : [];
    });
    if (!params.includes(paramName)) return;
    if (node.start === candidate.start && node.end === candidate.end) return;
    if (!isForwardOnly(program, node, paramName)) return;
    forwarders.count += 1;
    const label = `${paramName} forwarded unread in ${filePath}`;
    if (!forwarders.passThrough.includes(label)) forwarders.passThrough.push(label);
  };
  new Visitor({
    FunctionDeclaration: matches,
    FunctionExpression: matches,
    ArrowFunctionExpression: matches,
  }).visit(program);
}

export function buildTransitivePlumbingEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): TransitivePlumbingEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const params = simpleParamNames(fn);
  if (params.length === 0) return undefined;

  const plumbedParams: PlumbedParam[] = [];
  for (const name of params) {
    if (!isForwardOnly(parsed.program, fn, name)) continue;
    const callees = forwardedCallees(parsed.program, fn, name);
    if (callees.length === 0) continue;
    const downstreamParamMatch = callees.some((callee) => {
      if (declaredFunctionNames(parsed.program, name).includes(callee)) return true;
      return projectFiles.some((file) => {
        if (file.filePath === owner.filePath) return false;
        const fileParsed = parseCached(file.filePath, file.source);
        if (fileParsed.errors.some((error) => error.severity === "Error")) return false;
        return declaredFunctionNames(fileParsed.program, name).includes(callee);
      });
    });
    plumbedParams.push({ name, forwardedTo: callees, downstreamParamMatch });
  }
  if (plumbedParams.length === 0) return undefined;

  const candidateName = functionName(parsed.program, fn);
  let chainDepth = 1;
  const sameNameForwarders: string[] = [];
  const sameNamePassThrough: string[] = [];
  for (const param of plumbedParams) {
    const forwarders: ForwarderTally = { count: 0, passThrough: [] };
    for (const file of projectFiles.slice(0, MAX_PROJECT_FILES)) {
      const fileParsed = parseCached(file.filePath, file.source);
      if (fileParsed.errors.some((error) => error.severity === "Error")) continue;
      for (const declared of declaredFunctionNames(fileParsed.program, param.name)) {
        if (file.filePath === owner.filePath && declared === candidateName) continue;
        const label = `${param.name}: ${declared} in ${file.filePath}`;
        if (!sameNameForwarders.includes(label)) sameNameForwarders.push(label);
      }
      matchForwardOnlyInFile(
        fileParsed.program,
        file.filePath,
        owner.filePath,
        param.name,
        candidate,
        forwarders,
      );
    }
    chainDepth = Math.max(chainDepth, 1 + forwarders.count);
    sameNamePassThrough.push(...forwarders.passThrough);
  }
  if (chainDepth < 3) return undefined;

  const name = candidateName;
  const exported = name ? isFunctionExported(parsed.program, fn, name) : false;
  const publicBoundary = exported && findModuleImporters(candidate.filePath, projectFiles).length > 0;
  return {
    function: {
      name: name ?? null,
      exported,
      publicBoundary,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    plumbedParams,
    chainDepth,
    sameNameForwarders: sameNameForwarders.slice(0, 10),
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      sameNamePassThrough: sameNamePassThrough.slice(0, 10),
    },
  };
}
