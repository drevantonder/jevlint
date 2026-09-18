import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionNode } from "./repository.js";

export type FlagBranchUse = {
  kind: "if" | "conditional";
  test: string;
  line: number;
};

export type FlagParameter = {
  name: string;
  booleanAnnotated: boolean;
  booleanDefault: boolean;
  optionsBag: boolean;
  uses: FlagBranchUse[];
};

export type LiteralCallSites = {
  trueCount: number;
  falseCount: number;
  otherCount: number;
  examples: string[];
};

export type ModeFlagParameterEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  flag: FlagParameter;
  branchOverlap: {
    consequentOpcodes: string[];
    alternateOpcodes: string[];
    sharedOpcodes: number;
    disjoint: boolean;
  } | null;
  callSites: LiteralCallSites;
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

type ParamInfo = {
  name: string;
  source: string;
  optionsBag: boolean;
};

function paramInfos(fn: FunctionNode, source: string): ParamInfo[] {
  const infos: ParamInfo[] = [];
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    const text = source.slice(parameter.start, parameter.end);
    if (value.type === "Identifier") {
      infos.push({ name: value.name, source: text, optionsBag: false });
    } else if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
      infos.push({ name: value.left.name, source: text, optionsBag: false });
    } else if (value.type === "ObjectPattern") {
      for (const property of value.properties) {
        if (property.type === "Property" && property.key.type === "Identifier") {
          infos.push({ name: property.key.name, source: text, optionsBag: true });
        }
      }
    }
  }
  return infos;
}

function opcodesOf(source: string, start: number, end: number): string[] {
  const wrapped = `function __flag() ${source.slice(start, end).startsWith("{") ? source.slice(start, end) : `{ ${source.slice(start, end)} }`}`;
  const parsed = parseCached("flag.ts", wrapped);
  if (parsed.errors.some((error) => error.severity === "Error")) return [];
  const opcodes: string[] = [];
  new Visitor({
    ExpressionStatement: () => {
      opcodes.push("ExpressionStatement");
    },
    IfStatement: () => {
      opcodes.push("IfStatement");
    },
    ReturnStatement: () => {
      opcodes.push("ReturnStatement");
    },
    VariableDeclaration: () => {
      opcodes.push("VariableDeclaration");
    },
    ForStatement: () => {
      opcodes.push("ForStatement");
    },
    WhileStatement: () => {
      opcodes.push("WhileStatement");
    },
    SwitchStatement: () => {
      opcodes.push("SwitchStatement");
    },
    TryStatement: () => {
      opcodes.push("TryStatement");
    },
    ThrowStatement: () => {
      opcodes.push("ThrowStatement");
    },
  }).visit(parsed.program);
  return opcodes.sort();
}

function sharedOpcodeCount(left: string[], right: string[]): number {
  const counts = new Map<string, number>();
  for (const opcode of right) counts.set(opcode, (counts.get(opcode) ?? 0) + 1);
  let shared = 0;
  for (const opcode of left) {
    const remaining = counts.get(opcode) ?? 0;
    if (remaining > 0) {
      shared += 1;
      counts.set(opcode, remaining - 1);
    }
  }
  return shared;
}

export function buildModeFlagParameterEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ModeFlagParameterEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const params = paramInfos(fn, owner.source);
  if (params.length === 0) return undefined;
  const nested = nestedFunctionRanges(parsed.program, candidate);

  const flags: { param: ParamInfo; uses: FlagBranchUse[]; firstAlternate: { start: number; end: number } | null; firstConsequent: { start: number; end: number } | null }[] = params.map((param) => ({
    param,
    uses: [],
    firstAlternate: null,
    firstConsequent: null,
  }));

  const recordUse = (
    paramName: string,
    use: FlagBranchUse,
    consequent: { start: number; end: number },
    alternate: { start: number; end: number } | null,
  ): void => {
    const flag = flags.find(({ param }) => param.name === paramName);
    if (!flag) return;
    flag.uses.push(use);
    if (!flag.firstConsequent) {
      flag.firstConsequent = consequent;
      flag.firstAlternate = alternate;
    }
  };

  new Visitor({
    IfStatement(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (nested.some((range) => range.start <= node.start && range.end >= node.end)) return;
      const test = owner.source.slice(node.test.start, node.test.end);
      const used = params.find(({ name: paramName }) => new RegExp(`\\b${paramName}\\b`).test(test));
      if (!used) return;
      recordUse(used.name, {
        kind: "if",
        test,
        line: lineAt(owner.source, node.start),
      }, { start: node.consequent.start, end: node.consequent.end }, node.alternate
        ? { start: node.alternate.start, end: node.alternate.end }
        : null);
    },
    ConditionalExpression(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (nested.some((range) => range.start <= node.start && range.end >= node.end)) return;
      const test = owner.source.slice(node.test.start, node.test.end);
      const used = params.find(({ name: paramName }) => new RegExp(`\\b${paramName}\\b`).test(test));
      if (!used) return;
      recordUse(used.name, {
        kind: "conditional",
        test,
        line: lineAt(owner.source, node.start),
      }, { start: node.consequent.start, end: node.consequent.end }, {
        start: node.alternate.start,
        end: node.alternate.end,
      });
    },
  }).visit(parsed.program);

  const candidates = flags.filter(({ uses }) => uses.length > 0);
  if (candidates.length === 0) return undefined;

  const scored = candidates.map((flag) => {
    const booleanAnnotated = /:\s*boolean\b/.test(flag.param.source);
    const booleanDefault = /=\s*(true|false)\b/.test(flag.param.source);
    return { flag, booleanAnnotated, booleanDefault };
  }).filter(({ booleanAnnotated, booleanDefault, flag }) =>
    booleanAnnotated || booleanDefault || flag.uses.length >= 1
  );
  const pick = scored.find(({ booleanAnnotated, booleanDefault }) => booleanAnnotated || booleanDefault)
    ?? scored.sort((left, right) => right.flag.uses.length - left.flag.uses.length)[0];
  if (!pick) return undefined;

  const consequentOpcodes = pick.flag.firstConsequent
    ? opcodesOf(owner.source, pick.flag.firstConsequent.start, pick.flag.firstConsequent.end)
    : [];
  const alternateOpcodes = pick.flag.firstAlternate
    ? opcodesOf(owner.source, pick.flag.firstAlternate.start, pick.flag.firstAlternate.end)
    : [];
  const shared = sharedOpcodeCount(consequentOpcodes, alternateOpcodes);
  const total = Math.max(consequentOpcodes.length + alternateOpcodes.length, 1);

  const callSites: LiteralCallSites = { trueCount: 0, falseCount: 0, otherCount: 0, examples: [] };
  const callers = findFunctionCallers(owner.filePath, name, projectFiles);
  const paramIndex = params.findIndex(({ name: paramName }) => paramName === pick.flag.param.name);
  for (const caller of callers) {
    const argument = caller.arguments[paramIndex] ?? caller.arguments[caller.arguments.length - 1];
    if (argument === undefined) continue;
    const trimmed = argument.trim();
    if (trimmed === "true") {
      callSites.trueCount += 1;
    } else if (trimmed === "false") {
      callSites.falseCount += 1;
    } else {
      callSites.otherCount += 1;
    }
    if (callSites.examples.length < 8) callSites.examples.push(`${caller.filePath}:${caller.line}: ${caller.call}`);
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    flag: {
      name: pick.flag.param.name,
      booleanAnnotated: pick.booleanAnnotated,
      booleanDefault: pick.booleanDefault,
      optionsBag: pick.flag.param.optionsBag,
      uses: pick.flag.uses.slice(0, 10),
    },
    branchOverlap: pick.flag.firstConsequent
      ? {
        consequentOpcodes,
        alternateOpcodes,
        sharedOpcodes: shared,
        disjoint: shared / total < 0.5,
      }
      : null,
    callSites,
  };
}
