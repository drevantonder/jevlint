import { parseSync, Visitor } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type VariantArm = {
  kind: "if-branch" | "switch-case" | "conditional";
  test: string;
  value: string | null;
  bodyOpcodes: string[];
  dataLike: boolean;
  line: number;
};

export type VariantDiscriminant = {
  name: string;
  placement: "positional" | "options-bag";
  annotation: string;
  values: string[];
};

export type VariantCallerGroup = {
  value: string;
  count: number;
  files: string[];
};

export type VariantPartitionedHelperEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  discriminant: VariantDiscriminant;
  arms: VariantArm[];
  armOverlap: {
    sharedAcrossArms: string[];
    disjoint: boolean;
  };
  callerGroups: VariantCallerGroup[];
  mixedCallers: number;
  callerExamples: string[];
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
  index: number;
};

function paramInfos(fn: FunctionNode, source: string): ParamInfo[] {
  const infos: ParamInfo[] = [];
  fn.params.forEach((parameter, index) => {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    const text = source.slice(parameter.start, parameter.end);
    if (value.type === "Identifier") {
      infos.push({ name: value.name, source: text, optionsBag: false, index });
    } else if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
      infos.push({ name: value.left.name, source: text, optionsBag: false, index });
    } else if (value.type === "ObjectPattern") {
      for (const property of value.properties) {
        if (property.type === "Property" && property.key.type === "Identifier") {
          infos.push({ name: property.key.name, source: text, optionsBag: true, index });
        }
      }
    }
  });
  return infos;
}

function isBooleanParam(source: string): boolean {
  return /:\s*boolean\b/.test(source) || /=\s*(true|false)\b/.test(source);
}

function literalOf(test: string): string | null {
  const match = /["']([^"']+)["']/.exec(test);
  return match?.[1] ?? null;
}

function rootName(expression: string): string | undefined {
  const match = /^([\w$]+)/.exec(expression.trim());
  return match?.[1];
}

function bagFieldOf(test: string, paramName: string): string | null {
  const dot = new RegExp(`\\b${paramName}\\s*\\.\\s*([\\w$]+)`).exec(test)?.[1];
  if (dot) return dot;
  const bracket = new RegExp(`\\b${paramName}\\s*\\[\\s*["']([^"']+)["']\\s*\\]`).exec(test)?.[1];
  return bracket ?? null;
}

function opcodesOf(source: string, start: number, end: number): string[] {
  const body = source.slice(start, end);
  const wrapped = `function __variant() ${body.startsWith("{") ? body : `{ ${body} }`}`;
  const parsed = parseSync("variant.ts", wrapped, { range: true });
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

function isDataLike(source: string, start: number, end: number): boolean {
  const body = source.slice(start, end).trim();
  const inner = body.startsWith("{") ? body.replace(/^\{|\}$/g, "").trim() : body;
  return /^return\s*(["'`[{]|-?\d|true\b|false\b|null\b)/.test(inner)
    && !/;/.test(inner.replace(/^return\s*[^;]+/, ""));
}

export function buildVariantPartitionedHelperEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): VariantPartitionedHelperEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const params = paramInfos(fn, owner.source).filter(({ source }) => !isBooleanParam(source));
  if (params.length === 0) return undefined;
  const nested = nestedFunctionRanges(parsed.program, candidate);
  const own = (start: number, end: number): boolean =>
    start >= candidate.start && end <= candidate.end
    && !nested.some((range) => range.start <= start && range.end >= end);

  const armsByParam = new Map<string, VariantArm[]>();
  const metaByParam = new Map<string, { placement: "positional" | "options-bag"; annotation: string; index: number }>();
  const recordArm = (
    param: ParamInfo,
    keySource: string,
    arm: VariantArm,
  ): void => {
    const field = bagFieldOf(keySource, param.name);
    const key = field ?? param.name;
    armsByParam.set(key, [...(armsByParam.get(key) ?? []), arm]);
    if (!metaByParam.has(key)) {
      metaByParam.set(key, {
        placement: field ? "options-bag" : "positional",
        annotation: field ? keySource : param.source,
        index: param.index,
      });
    }
  };

  new Visitor({
    IfStatement(node) {
      if (!own(node.start, node.end)) return;
      const test = owner.source.slice(node.test.start, node.test.end);
      const param = params.find(({ name: paramName }) => new RegExp(`\\b${paramName}\\b`).test(test));
      if (!param) return;
      const value = literalOf(test);
      if (!value) return;
      recordArm(param, test, {
        kind: "if-branch",
        test,
        value,
        bodyOpcodes: opcodesOf(owner.source, node.consequent.start, node.consequent.end),
        dataLike: isDataLike(owner.source, node.consequent.start, node.consequent.end),
        line: lineAt(owner.source, node.start),
      });
    },
    ConditionalExpression(node) {
      if (!own(node.start, node.end)) return;
      const test = owner.source.slice(node.test.start, node.test.end);
      const param = params.find(({ name: paramName }) => new RegExp(`\\b${paramName}\\b`).test(test));
      if (!param) return;
      const value = literalOf(test);
      if (!value) return;
      recordArm(param, test, {
        kind: "conditional",
        test,
        value,
        bodyOpcodes: opcodesOf(owner.source, node.consequent.start, node.consequent.end),
        dataLike: isDataLike(owner.source, node.consequent.start, node.consequent.end),
        line: lineAt(owner.source, node.start),
      });
    },
    SwitchStatement(node) {
      if (!own(node.start, node.end)) return;
      const discriminant = owner.source.slice(node.discriminant.start, node.discriminant.end);
      const root = rootName(discriminant);
      const param = params.find(({ name: paramName }) =>
        paramName === root || new RegExp(`\\b${paramName}\\b`).test(discriminant));
      if (!param) return;
      for (const caseNode of node.cases) {
        if (!caseNode.test) continue;
        const test = owner.source.slice(caseNode.test.start, caseNode.test.end);
        const value = literalOf(test);
        if (!value) continue;
        const bodyStart = caseNode.consequent.length > 0
          ? caseNode.consequent[0]?.start ?? caseNode.test.end
          : caseNode.test.end;
        const last = caseNode.consequent[caseNode.consequent.length - 1];
        const bodyEnd = last?.end ?? caseNode.test.end;
        recordArm(param, discriminant, {
          kind: "switch-case",
          test,
          value,
          bodyOpcodes: opcodesOf(owner.source, bodyStart, bodyEnd),
          dataLike: isDataLike(owner.source, bodyStart, bodyEnd),
          line: lineAt(owner.source, caseNode.start),
        });
      }
    },
  }).visit(parsed.program);

  const eligible = [...armsByParam.entries()].filter(([, arms]) =>
    new Set(arms.map(({ value }) => value)).size >= 2);
  if (eligible.length === 0) return undefined;
  eligible.sort((left, right) => right[1].length - left[1].length);
  const first = eligible[0];
  if (!first) return undefined;
  const [pickName, pickArms] = first;
  const pickMeta = metaByParam.get(pickName);
  if (!pickMeta) return undefined;
  const arms = pickArms.slice(0, 12);

  const counts = new Map<string, number>();
  for (const arm of arms) {
    for (const opcode of new Set(arm.bodyOpcodes)) {
      counts.set(opcode, (counts.get(opcode) ?? 0) + 1);
    }
  }
  const sharedAcrossArms = [...counts]
    .filter(([, count]) => count >= 2)
    .map(([opcode]) => opcode)
    .sort();

  const opcodeCounts = (opcodes: string[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const opcode of opcodes) map.set(opcode, (map.get(opcode) ?? 0) + 1);
    return map;
  };
  let maxPairOverlap = 0;
  for (let left = 0; left < arms.length; left += 1) {
    for (let right = left + 1; right < arms.length; right += 1) {
      const leftCounts = opcodeCounts(arms[left]?.bodyOpcodes ?? []);
      const rightCounts = opcodeCounts(arms[right]?.bodyOpcodes ?? []);
      let shared = 0;
      for (const [opcode, count] of leftCounts) {
        shared += Math.min(count, rightCounts.get(opcode) ?? 0);
      }
      const total = (arms[left]?.bodyOpcodes.length ?? 0) + (arms[right]?.bodyOpcodes.length ?? 0);
      if (total > 0) maxPairOverlap = Math.max(maxPairOverlap, shared / total);
    }
  }

  const groups = new Map<string, { count: number; files: Set<string> }>();
  let mixedCallers = 0;
  const callerExamples: string[] = [];
  const callers: FunctionCaller[] = findFunctionCallers(owner.filePath, name, projectFiles);
  for (const caller of callers) {
    let raw: string | undefined;
    if (pickMeta.placement === "options-bag") {
      const objectArg = caller.arguments.find((argument) => argument.trim().startsWith("{"));
      const match = objectArg
        ? new RegExp(`${pickName}\\s*:\\s*(["'])([^"']+)\\1`).exec(objectArg)
        : null;
      raw = match?.[2];
    } else {
      const argument = caller.arguments[pickMeta.index] ?? caller.arguments[caller.arguments.length - 1];
      if (argument !== undefined) {
        raw = /^["']([^"']+)["']$/.exec(argument.trim())?.[1];
      }
    }
    if (raw === undefined) {
      mixedCallers += 1;
    } else {
      const group = groups.get(raw) ?? { count: 0, files: new Set<string>() };
      group.count += 1;
      group.files.add(caller.filePath);
      groups.set(raw, group);
    }
    if (callerExamples.length < 8) callerExamples.push(`${caller.filePath}:${caller.line}: ${caller.call}`);
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    discriminant: {
      name: pickName,
      placement: pickMeta.placement,
      annotation: pickMeta.annotation.trim().slice(0, 200),
      values: [...new Set(arms.map(({ value }) => value ?? ""))].filter((value) => value !== ""),
    },
    arms,
    armOverlap: {
      sharedAcrossArms,
      disjoint: arms.length < 2 ? true : maxPairOverlap < 0.5,
    },
    callerGroups: [...groups.entries()]
      .map(([value, group]): VariantCallerGroup => ({
        value,
        count: group.count,
        files: [...group.files].slice(0, 5),
      }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 8),
    mixedCallers,
    callerExamples,
  };
}
