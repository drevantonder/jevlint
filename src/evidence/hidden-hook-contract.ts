import { Visitor } from "oxc-parser";
import type { CallExpression } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findNamedFunction,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type HiddenHookCall = {
  callee: string;
  nested: boolean;
  source: string;
};

export type HiddenHookCalleeResolution = {
  callee: string;
  localDefinition: boolean;
  definitionCallsHooks: boolean;
  definitionSource: string | null;
};

export type RiskyCaller = {
  filePath: string;
  call: string;
  line: number;
  context: "conditional" | "loop" | "closure";
};

export type HiddenHookContractEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  hookCalls: HiddenHookCall[];
  calleeResolutions: HiddenHookCalleeResolution[];
  callers: FunctionCaller[];
  riskyCallers: RiskyCaller[];
};

const HOOK_CALL = /^use[A-Z]/;
const DECLARED_HOOK = /^use[A-Z]/;
const CAPITALIZED_COMPONENT = /^[A-Z]/;

type HookCallee = { name: string; qualified: string; bare: boolean };

function hookCalleeOf(call: CallExpression): HookCallee | undefined {
  const callee = call.callee;
  if (callee.type === "Identifier") {
    if (!HOOK_CALL.test(callee.name)) return undefined;
    return { name: callee.name, qualified: callee.name, bare: true };
  }
  if (
    callee.type === "MemberExpression"
    && !callee.computed
    && callee.property.type === "Identifier"
    && HOOK_CALL.test(callee.property.name)
  ) {
    return { name: callee.property.name, qualified: `*.${callee.property.name}`, bare: false };
  }
  return undefined;
}

function definitionCallsHooks(
  program: Parameters<typeof findNamedFunction>[0],
  definition: FunctionNode,
): boolean {
  let found = false;
  new Visitor({
    CallExpression(call) {
      if (found) return;
      if (call.start < definition.start || call.end > definition.end) return;
      if (hookCalleeOf(call) !== undefined) found = true;
    },
  }).visit(program);
  return found;
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function findRiskyCallers(
  ownerPath: string,
  name: string,
  candidateStart: number,
  candidateEnd: number,
  projectFiles: ProjectFile[],
): RiskyCaller[] {
  const risky: RiskyCaller[] = [];
  for (const file of projectFiles) {
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    let conditionalDepth = 0;
    let loopDepth = 0;
    let functionDepth = 0;
    const enterConditional = (): void => {
      conditionalDepth += 1;
    };
    const exitConditional = (): void => {
      conditionalDepth -= 1;
    };
    const enterLoop = (): void => {
      loopDepth += 1;
    };
    const exitLoop = (): void => {
      loopDepth -= 1;
    };
    const enterFunction = (): void => {
      functionDepth += 1;
    };
    const exitFunction = (): void => {
      functionDepth -= 1;
    };
    new Visitor({
      IfStatement: enterConditional,
      "IfStatement:exit": exitConditional,
      ConditionalExpression: enterConditional,
      "ConditionalExpression:exit": exitConditional,
      SwitchStatement: enterConditional,
      "SwitchStatement:exit": exitConditional,
      LogicalExpression: enterConditional,
      "LogicalExpression:exit": exitConditional,
      ForStatement: enterLoop,
      "ForStatement:exit": exitLoop,
      ForInStatement: enterLoop,
      "ForInStatement:exit": exitLoop,
      ForOfStatement: enterLoop,
      "ForOfStatement:exit": exitLoop,
      WhileStatement: enterLoop,
      "WhileStatement:exit": exitLoop,
      DoWhileStatement: enterLoop,
      "DoWhileStatement:exit": exitLoop,
      ArrowFunctionExpression: enterFunction,
      "ArrowFunctionExpression:exit": exitFunction,
      FunctionDeclaration: enterFunction,
      "FunctionDeclaration:exit": exitFunction,
      FunctionExpression: enterFunction,
      "FunctionExpression:exit": exitFunction,
      CallExpression(call) {
        if (call.callee.type !== "Identifier" || call.callee.name !== name) return;
        if (
          file.filePath === ownerPath
          && call.start >= candidateStart
          && call.end <= candidateEnd
        ) return;
        const context = loopDepth > 0
          ? "loop"
          : conditionalDepth > 0
            ? "conditional"
            : functionDepth >= 2
              ? "closure"
              : null;
        if (context === null) return;
        if (risky.length >= 20) return;
        risky.push({
          filePath: file.filePath,
          call: file.source.slice(call.start, call.end).slice(0, 300),
          line: lineAt(file.source, call.start),
          context,
        });
      },
    }).visit(parsed.program);
  }
  return risky;
}

export function buildHiddenHookContractEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HiddenHookContractEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  if (DECLARED_HOOK.test(name)) return undefined;
  if (CAPITALIZED_COMPONENT.test(name)) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const hookCalls: HiddenHookCall[] = [];
  new Visitor({
    CallExpression(call) {
      if (call.start < candidate.start || call.end > candidate.end) return;
      const hookCallee = hookCalleeOf(call);
      if (!hookCallee) return;
      const inNested = nested.some(
        (range) => range.start <= call.start && range.end >= call.end,
      );
      if (hookCalls.length >= 20) return;
      hookCalls.push({
        callee: hookCallee.qualified,
        nested: inNested,
        source: owner.source.slice(call.start, call.end).slice(0, 300),
      });
    },
  }).visit(parsed.program);
  if (hookCalls.length === 0) return undefined;

  const resolutions = new Map<string, HiddenHookCalleeResolution>();
  for (const call of hookCalls) {
    if (!call.callee || call.callee.startsWith("*.")) continue;
    if (resolutions.has(call.callee)) continue;
    const definition = findNamedFunction(parsed.program, call.callee);
    if (!definition) {
      resolutions.set(call.callee, {
        callee: call.callee,
        localDefinition: false,
        definitionCallsHooks: false,
        definitionSource: null,
      });
      continue;
    }
    resolutions.set(call.callee, {
      callee: call.callee,
      localDefinition: true,
      definitionCallsHooks: definitionCallsHooks(parsed.program, definition),
      definitionSource: owner.source.slice(definition.start, definition.end).slice(0, 400),
    });
  }
  const calleeResolutions = [...resolutions.values()];

  const genuine = hookCalls.some((call) => {
    if (call.callee.startsWith("*.")) return true;
    const resolution = resolutions.get(call.callee);
    if (!resolution) return true;
    if (!resolution.localDefinition) return true;
    return resolution.definitionCallsHooks;
  });
  if (!genuine) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    hookCalls,
    calleeResolutions,
    callers: findFunctionCallers(owner.filePath, name, projectFiles),
    riskyCallers: findRiskyCallers(
      owner.filePath,
      name,
      candidate.start,
      candidate.end,
      projectFiles,
    ),
  };
}
