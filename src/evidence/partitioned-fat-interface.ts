import { parseSync, Visitor } from "oxc-parser";
import type { CallExpression, Class, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";

const MAX_METHODS = 12;
const MAX_CALLER_FILES = 12;
const MAX_DISJOINT_PAIRS = 8;
const MAX_EXCERPT_CHARS = 500;
const MAX_CALL_CHARS = 240;

export type PartitionCallerSample = {
  filePath: string;
  call: string;
  line: number;
};

export type PartitionMethodEvidence = {
  name: string;
  arity: number;
  source: string;
  callerFiles: string[];
  callerTotal: number;
  callerSample: PartitionCallerSample[];
};

export type PartitionedFatInterfaceEvidence = {
  class: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  methods: PartitionMethodEvidence[];
  disjointPairs: { left: string; right: string }[];
  coverage: {
    totalMethods: number;
    includedMethods: number;
    totalCallerFiles: number;
  };
};

function locateClass(program: Program, candidate: Candidate): Class | undefined {
  let node: Class | undefined;
  new Visitor({
    ClassDeclaration(found) {
      if (found.start === candidate.start && found.end === candidate.end) node = found;
    },
  }).visit(program);
  return node;
}

function methodKey(member: Class["body"]["body"][number]): string | undefined {
  if (member.type !== "MethodDefinition") return undefined;
  const key = member.key;
  if (!key) return undefined;
  if (key.type === "Identifier" && !member.computed) return key.name;
  if (key.type === "PrivateIdentifier") return `#${key.name}`;
  return undefined;
}

function isPublicMethod(member: Class["body"]["body"][number]): boolean {
  if (member.type !== "MethodDefinition") return false;
  if (member.kind !== "method" && member.kind !== "get" && member.kind !== "set") return false;
  if (member.value.type !== "FunctionExpression" || member.value.body === null) return false;
  const name = methodKey(member);
  if (!name || name === "constructor" || name.startsWith("#") || name.startsWith("_")) return false;
  return true;
}

function isExported(program: Program, node: Class, name: string): boolean {
  for (const statement of program.body) {
    if (statement.type === "ExportDefaultDeclaration" && statement.declaration === node) return true;
    if (statement.type !== "ExportNamedDeclaration") continue;
    if (statement.declaration === node) return true;
    if (
      statement.specifiers.some((specifier) => {
        const local = specifier.local;
        return local.type === "Identifier" && local.name === name;
      })
    ) return true;
  }
  return false;
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function callerFilesFor(
  method: string,
  projectFiles: ProjectFile[],
) {
  const files = new Set<string>();
  const sample: PartitionCallerSample[] = [];
  let total = 0;
  for (const file of projectFiles) {
    const parsed = parseSync(file.filePath, file.source, { range: true });
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
    if (calls.length === 0) continue;
    total += calls.length;
    files.add(file.filePath);
    for (const call of calls.slice(0, Math.max(0, MAX_CALLER_FILES - sample.length))) {
      sample.push({
        filePath: file.filePath,
        call: file.source.slice(call.start, call.end).slice(0, MAX_CALL_CHARS),
        line: lineAt(file.source, call.start),
      });
    }
  }
  return { files: [...files].sort((left, right) => left.localeCompare(right)), total, sample };
}

export function buildPartitionedFatInterfaceEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): PartitionedFatInterfaceEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const node = locateClass(parsed.program, candidate);
  if (!node) return undefined;
  const name = node.id?.name;
  if (!name) return undefined;

  const members = node.body.body.filter(isPublicMethod);
  if (members.length < 3) return undefined;

  const methods: PartitionMethodEvidence[] = [];
  for (const member of members.slice(0, MAX_METHODS)) {
    const methodName = methodKey(member) ?? "unknown";
    const params = member.type === "MethodDefinition" && member.value.type === "FunctionExpression"
      ? member.value.params.length
      : 0;
    const callers = callerFilesFor(methodName, projectFiles);
    methods.push({
      name: methodName,
      arity: params,
      source: owner.source.slice(member.start, member.end).slice(0, MAX_EXCERPT_CHARS),
      callerFiles: callers.files.slice(0, MAX_CALLER_FILES),
      callerTotal: callers.total,
      callerSample: callers.sample,
    });
  }
  if (methods.every(({ callerTotal }) => callerTotal === 0)) return undefined;

  const fileSets = methods.map(({ callerFiles }) => new Set(callerFiles));
  const disjointPairs: { left: string; right: string }[] = [];
  for (let left = 0; left < methods.length; left += 1) {
    for (let right = left + 1; right < methods.length; right += 1) {
      if (disjointPairs.length >= MAX_DISJOINT_PAIRS) break;
      const shared = [...(fileSets[left] ?? new Set<string>())].some((file) =>
        fileSets[right]?.has(file)
      );
      if (!shared) {
        disjointPairs.push({
          left: methods[left]?.name ?? "unknown",
          right: methods[right]?.name ?? "unknown",
        });
      }
    }
    if (disjointPairs.length >= MAX_DISJOINT_PAIRS) break;
  }

  return {
    class: {
      name,
      exported: isExported(parsed.program, node, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    methods,
    disjointPairs,
    coverage: {
      totalMethods: members.length,
      includedMethods: methods.length,
      totalCallerFiles: new Set(methods.flatMap(({ callerFiles }) => callerFiles)).size,
    },
  };
}
