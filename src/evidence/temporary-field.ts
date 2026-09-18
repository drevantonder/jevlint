import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Class, Expression, MemberExpression, MethodDefinition, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";

export type TemporaryFieldAssignment = {
  field: string;
  method: string;
  line: number;
};

export type TemporaryFieldRead = {
  field: string;
  method: string;
  guarded: boolean;
  line: number;
};

export type TemporaryField = {
  name: string;
  optional: boolean;
  declaredNullable: boolean;
  hasInitializer: boolean;
  assignedInConstructor: boolean;
  assignedInMethods: string[];
  readInMethods: string[];
  guardedReads: number;
};

export type MethodSequenceEvidence = {
  method: string;
  externalCalls: number;
};

export type TemporaryFieldEvidence = {
  abstraction: {
    name: string;
    kind: "class";
    filePath: string;
    source: string;
  };
  fields: TemporaryField[];
  assignments: TemporaryFieldAssignment[];
  reads: TemporaryFieldRead[];
  sequence: MethodSequenceEvidence[];
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

function methodName(definition: MethodDefinition): string {
  if (definition.kind === "constructor") return "constructor";
  if (definition.key.type === "Identifier") return definition.key.name;
  if (definition.key.type === "PrivateIdentifier") return `#${definition.key.name}`;
  return "computed";
}

function thisFieldName(expression: MemberExpression): string | undefined {
  if (expression.computed) return undefined;
  if (expression.object.type !== "ThisExpression") return undefined;
  if (expression.property.type === "Identifier") return expression.property.name;
  if (expression.property.type === "PrivateIdentifier") return `#${expression.property.name}`;
  return undefined;
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type SourceRange = {
  start: number;
  end: number;
};

type MethodRange = {
  name: string;
  start: number;
  end: number;
};

export function buildTemporaryFieldEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): TemporaryFieldEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const node = findClass(parsed.program, candidate);
  if (!node) return undefined;
  const name = node.id?.name;
  if (!name) return undefined;

  const methods = node.body.body.filter((element): element is MethodDefinition =>
    element.type === "MethodDefinition" && !element.static
  );
  if (methods.length === 0) return undefined;
  const ranges: MethodRange[] = methods.map((definition) => ({
    name: methodName(definition),
    start: definition.value.start,
    end: definition.value.end,
  }));
  const enclosing = (start: number, end: number): string | undefined =>
    ranges.find((range) => range.start <= start && end <= range.end)?.name;

  const declared = new Map<string, { optional: boolean; declaredNullable: boolean; hasInitializer: boolean }>();
  for (const element of node.body.body) {
    if (element.type !== "PropertyDefinition" || element.static) continue;
    const key = element.key.type === "Identifier" ? element.key.name : undefined;
    if (!key) continue;
    const annotation = element.typeAnnotation
      ? owner.source.slice(element.typeAnnotation.start, element.typeAnnotation.end)
      : "";
    declared.set(key, {
      optional: element.optional === true,
      declaredNullable: /\bundefined\b|\bnull\b|\?/.test(annotation),
      hasInitializer: element.value !== null,
    });
  }

  const guardKey = (method: string, field: string): string => `${method}::${field}`;
  const guards = new Set<string>();
  const writeTargets: SourceRange[] = [];
  const assignments: TemporaryFieldAssignment[] = [];
  const reads: TemporaryFieldRead[] = [];
  const recordGuard = (method: string | undefined, test: Expression): void => {
    if (!method) return;
    const text = owner.source.slice(test.start, test.end);
    for (const field of declared.keys()) {
      if (new RegExp(`this\\s*\\??\\.\\s*${escapeRegExp(field)}\\b`).test(text)) {
        guards.add(guardKey(method, field));
      }
    }
  };
  new Visitor({
    IfStatement(statement) {
      recordGuard(enclosing(statement.start, statement.end), statement.test);
    },
    ConditionalExpression(expression) {
      recordGuard(enclosing(expression.start, expression.end), expression.test);
    },
    AssignmentExpression(expression) {
      if (expression.left.type !== "MemberExpression") return;
      const field = thisFieldName(expression.left);
      const method = enclosing(expression.start, expression.end);
      if (!field || !method) return;
      writeTargets.push({ start: expression.left.start, end: expression.left.end });
      assignments.push({ field, method, line: lineAt(owner.source, expression.start) });
    },
    UpdateExpression(expression) {
      if (expression.argument.type !== "MemberExpression") return;
      const field = thisFieldName(expression.argument);
      const method = enclosing(expression.start, expression.end);
      if (!field || !method) return;
      writeTargets.push({ start: expression.argument.start, end: expression.argument.end });
      assignments.push({ field, method, line: lineAt(owner.source, expression.start) });
    },
    MemberExpression(expression) {
      if (writeTargets.some((target) => target.start === expression.start && target.end === expression.end)) return;
      const field = thisFieldName(expression);
      const method = enclosing(expression.start, expression.end);
      if (!field || !method) return;
      reads.push({
        field,
        method,
        guarded: guards.has(guardKey(method, field)),
        line: lineAt(owner.source, expression.start),
      });
    },
  }).visit(parsed.program);

  const outsideConstructor = assignments.filter(({ method }) => method !== "constructor");
  if (outsideConstructor.length === 0) return undefined;

  const assignedIn = (field: string): string[] =>
    [...new Set(assignments.filter(({ field: assigned }) => assigned === field).map(({ method }) => method))];
  const readIn = (field: string): string[] =>
    [...new Set(reads.filter(({ field: read }) => read === field).map(({ method }) => method))];
  const allFields = new Set([
    ...declared.keys(),
    ...assignments.map(({ field }) => field),
    ...reads.map(({ field }) => field),
  ]);
  const fields: TemporaryField[] = [...allFields].sort().map((field) => {
    const info = declared.get(field) ?? { optional: false, declaredNullable: false, hasInitializer: false };
    const writers = assignedIn(field);
    return {
      name: field,
      optional: info.optional,
      declaredNullable: info.declaredNullable,
      hasInitializer: info.hasInitializer,
      assignedInConstructor: writers.includes("constructor"),
      assignedInMethods: writers.filter((method) => method !== "constructor").sort(),
      readInMethods: readIn(field).sort(),
      guardedReads: reads.filter(({ field: read, guarded }) => read === field && guarded).length,
    };
  });

  const methodNames = methods
    .filter(({ kind }) => kind === "method")
    .map((definition) => methodName(definition));
  const externalCalls = new Map<string, number>(methodNames.map((method) => [method, 0]));
  for (const file of projectFiles) {
    const fileParsed = parseCached(file.filePath, file.source);
    if (fileParsed.errors.some((error) => error.severity === "Error")) continue;
    new Visitor({
      CallExpression(call) {
        if (
          call.callee.type === "MemberExpression"
          && !call.callee.computed
          && call.callee.property.type === "Identifier"
          && externalCalls.has(call.callee.property.name)
        ) {
          externalCalls.set(
            call.callee.property.name,
            (externalCalls.get(call.callee.property.name) ?? 0) + 1,
          );
        }
      },
    }).visit(fileParsed.program);
  }

  return {
    abstraction: {
      name,
      kind: "class",
      filePath: owner.filePath,
      source: candidate.source,
    },
    fields,
    assignments: assignments.slice(0, 20),
    reads: reads.slice(0, 20),
    sequence: methodNames.map((method) => ({ method, externalCalls: externalCalls.get(method) ?? 0 })),
  };
}
