import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type {
  CallExpression,
  Class,
  Expression,
  Program,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { moduleImports } from "./repository.js";

const MAX_METHODS = 12;
const MAX_CALLERS_PER_METHOD = 2;
const MAX_CALLER_METHODS = 8;
const MAX_CLUSTERS = 6;
const MAX_METHOD_SOURCE_CHARS = 2_000;

export type CohesionMethodEvidence = {
  name: string;
  kind: string;
  static: boolean;
  fields: string[];
  importSources: string[];
  source: string;
  sourceTruncated: boolean;
};

export type MethodCallerEvidence = {
  method: string;
  total: number;
  callers: Array<{ filePath: string; call: string; line: number }>;
};

export type LowCohesionClassEvidence = {
  class: {
    name: string;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  fields: string[];
  methods: CohesionMethodEvidence[];
  clusters: string[][];
  methodCallers: MethodCallerEvidence[];
  coverage: {
    totalMethods: number;
    includedMethods: number;
    omittedMethods: number;
    truncatedMethods: number;
    totalCallers: number;
    includedCallers: number;
  };
};

function findClass(program: Program, candidate: Candidate): Class | undefined {
  let result: Class | undefined;
  new Visitor({
    ClassDeclaration(node) {
      if (node.start === candidate.start && node.end === candidate.end) result = node;
    },
  }).visit(program);
  return result;
}

function memberName(member: Class["body"]["body"][number]): string | undefined {
  if (member.type !== "MethodDefinition" && member.type !== "PropertyDefinition") return undefined;
  const key = member.key;
  if (!key) return undefined;
  if (key.type === "Identifier") return key.name;
  if (key.type === "PrivateIdentifier") return `#${key.name}`;
  return undefined;
}

function isMethod(member: Class["body"]["body"][number]): boolean {
  return member.type === "MethodDefinition"
    && (member.kind === "method" || member.kind === "get" || member.kind === "set")
    && member.value.type === "FunctionExpression"
    && member.value.body !== null;
}

function thisFields(program: Program, start: number, end: number): string[] {
  const fields = new Set<string>();
  new Visitor({
    MemberExpression(node) {
      if (node.start < start || node.end > end) return;
      if (node.object.type !== "ThisExpression") return;
      if (node.property.type === "Identifier" && !node.computed) fields.add(node.property.name);
      if (node.property.type === "PrivateIdentifier") fields.add(`#${node.property.name}`);
    },
  }).visit(program);
  return [...fields].sort((left, right) => left.localeCompare(right));
}

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") return rootIdentifier(expression.object);
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  return undefined;
}

function methodImportSources(program: Program, start: number, end: number): string[] {
  const imports = moduleImports(program);
  const byLocal = new Map(imports.map((imported) => [imported.local, imported.source]));
  const sources = new Set<string>();
  new Visitor({
    CallExpression(call) {
      if (call.start < start || call.end > end) return;
      const root = rootIdentifier(call.callee);
      const source = root === undefined ? undefined : byLocal.get(root);
      if (source !== undefined) sources.add(source);
    },
  }).visit(program);
  return [...sources].sort((left, right) => left.localeCompare(right));
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function methodCallers(
  method: string,
  projectFiles: ProjectFile[],
): MethodCallerEvidence {
  const callers: MethodCallerEvidence["callers"] = [];
  let total = 0;
  for (const file of projectFiles) {
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const calls: CallExpression[] = [];
    new Visitor({
      CallExpression(call) {
        const callee = call.callee;
        if (
          callee.type === "MemberExpression"
          && !callee.computed
          && callee.property.type === "Identifier"
          && callee.property.name === method
        ) calls.push(call);
      },
    }).visit(parsed.program);
    total += calls.length;
    for (const call of calls) {
      if (callers.length >= MAX_CALLERS_PER_METHOD) break;
      callers.push({
        filePath: file.filePath,
        call: file.source.slice(call.start, call.end).slice(0, 240),
        line: lineAt(file.source, call.start),
      });
    }
    if (callers.length >= MAX_CALLERS_PER_METHOD) break;
  }
  return { method, total, callers };
}

function connectedComponents(methods: CohesionMethodEvidence[]): string[][] {
  const eligible = methods.filter(({ name, kind }) => !(name === "constructor" && kind === "constructor"));
  const index = new Map(eligible.map((method, position) => [method.name, position]));
  const parent = eligible.map((_, position) => position);
  const find = (position: number): number => {
    const next = parent[position];
    if (next === undefined || next === position) return position;
    const root = find(next);
    parent[position] = root;
    return root;
  };
  const union = (left: number, right: number): void => {
    parent[find(left)] = find(right);
  };
  const fieldsByMethod = eligible.map(({ fields }) => new Set(fields));
  for (let left = 0; left < eligible.length; left += 1) {
    for (let right = left + 1; right < eligible.length; right += 1) {
      const shared = [...(fieldsByMethod[left] ?? new Set<string>())].some((field) =>
        fieldsByMethod[right]?.has(field)
      );
      if (shared) {
        const leftIndex = index.get(eligible[left]?.name ?? "");
        const rightIndex = index.get(eligible[right]?.name ?? "");
        if (leftIndex !== undefined && rightIndex !== undefined) union(leftIndex, rightIndex);
      }
    }
  }
  const groups = new Map<number, string[]>();
  eligible.forEach((method, position) => {
    const root = find(position);
    const group = groups.get(root) ?? [];
    group.push(method.name);
    groups.set(root, group);
  });
  return [...groups.values()]
    .map((group) => group.sort((left, right) => left.localeCompare(right)))
    .sort((left, right) => right.length - left.length || left[0]!.localeCompare(right[0]!))
    .slice(0, MAX_CLUSTERS);
}

export function buildLowCohesionClassEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): LowCohesionClassEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const node = findClass(parsed.program, candidate);
  if (!node) return undefined;
  const name = node.id?.name;
  if (!name) return undefined;

  const members = node.body.body;
  const fields = members.flatMap((member) =>
    member.type === "PropertyDefinition" && !member.static
      ? [memberName(member) ?? "unknown"] 
      : []
  ).filter((field) => field !== "unknown");
  const methodMembers = members.filter(isMethod);
  if (methodMembers.length < 2) return undefined;

  const methods = methodMembers.slice(0, MAX_METHODS).map((member): CohesionMethodEvidence => {
    const methodName = memberName(member) ?? "unknown";
    const isStatic = member.type === "MethodDefinition" && member.static;
    const raw = owner.source.slice(member.start, member.end);
    const truncated = raw.length > MAX_METHOD_SOURCE_CHARS;
    return {
      name: methodName,
      kind: member.type === "MethodDefinition" ? member.kind : "unknown",
      static: isStatic,
      fields: thisFields(parsed.program, member.start, member.end),
      importSources: methodImportSources(parsed.program, member.start, member.end),
      source: raw.slice(0, MAX_METHOD_SOURCE_CHARS),
      sourceTruncated: truncated,
    };
  });

  const publicMethods = methods
    .filter(({ name: methodName }) => !methodName.startsWith("#") && methodName !== "constructor")
    .slice(0, MAX_CALLER_METHODS);
  const callers = publicMethods.map(({ name: methodName }) => methodCallers(methodName, projectFiles));

  return {
    class: {
      name,
      filePath: owner.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    fields: [...new Set(fields)].sort((left, right) => left.localeCompare(right)),
    methods,
    clusters: connectedComponents(methods),
    methodCallers: callers,
    coverage: {
      totalMethods: methodMembers.length,
      includedMethods: methods.length,
      omittedMethods: methodMembers.length - methods.length,
      truncatedMethods: methods.filter(({ sourceTruncated }) => sourceTruncated).length,
      totalCallers: callers.reduce((total, item) => total + item.total, 0),
      includedCallers: callers.reduce((total, item) => total + item.callers.length, 0),
    },
  };
}
