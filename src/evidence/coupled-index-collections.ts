import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type {
  AssignmentExpression,
  ForOfStatement,
  ForStatement,
  MemberExpression,
  Node,
  ObjectExpression,
  UpdateExpression,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, containsNode, nestedFunctionRanges } from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type CoupledIndexCollectionEvidence = {
  name: string;
  provenance: "array-literal" | "array-parameter" | "array-binding";
  bindingSite: string;
  elementType: string | null;
  bufferKind: boolean;
  standaloneUses: string[];
};

export type CoupledIndexAccess = {
  collection: string;
  access: string;
  kind: "read" | "write";
};

export type CoupledIndexCollectionsEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  collections: CoupledIndexCollectionEvidence[];
  sharedIndex: string;
  loop: string;
  pairedAccesses: CoupledIndexAccess[];
  callers: FunctionCaller[];
};

type ArrayBinding = {
  name: string;
  provenance: CoupledIndexCollectionEvidence["provenance"];
  bindingSite: string;
  elementType: string | null;
  bufferKind: boolean;
  offset: number;
};

type Loop = ForStatement | ForOfStatement;

const ARRAY_TYPE = /\[\s*\]|Array\s*</;
const BUFFER_TYPE = /\b(Float32Array|Float64Array|Int8Array|Int16Array|Int32Array|Uint8Array|Uint8ClampedArray|Uint16Array|Uint32Array|BigInt64Array|BigUint64Array|ArrayBuffer|SharedArrayBuffer|DataView|\bBuffer\b)/;

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function annotationOf(source: string, node: Node): string | null {
  const slice = source.slice(node.start, node.end);
  const match = /:\s*([^=;,)]+?)\s*(?:=|$)/.exec(slice);
  const annotation = match?.[1]?.trim();
  return annotation ? annotation : null;
}

function parameterBinding(source: string, node: Node): ArrayBinding | undefined {
  const value = node.type === "TSParameterProperty" ? node.parameter : node;
  const target = value.type === "AssignmentPattern" && value.left.type === "Identifier"
    ? value.left
    : value.type === "Identifier"
      ? value
      : undefined;
  if (!target) return undefined;
  const slice = source.slice(value.start, value.end);
  const defaultIsArray = value.type === "AssignmentPattern"
    && (value.right.type === "ArrayExpression"
      || (value.right.type === "NewExpression"
        && value.right.callee.type === "Identifier"
        && value.right.callee.name === "Array"));
  if (!ARRAY_TYPE.test(slice) && !defaultIsArray) return undefined;
  return {
    name: target.name,
    provenance: "array-parameter",
    bindingSite: slice.slice(0, 500),
    elementType: annotationOf(source, value),
    bufferKind: BUFFER_TYPE.test(slice),
    offset: value.start,
  };
}

function forStatementIndex(loop: ForStatement, source: string): string | undefined {
  const init = loop.init;
  if (!init || init.type !== "VariableDeclaration" || init.declarations.length !== 1) {
    return undefined;
  }
  const declarator = init.declarations[0];
  if (!declarator || declarator.id.type !== "Identifier") return undefined;
  const name = declarator.id.name;
  if (!loop.test || !loop.update) return undefined;
  const pattern = new RegExp(`\\b${name}\\b`);
  if (!pattern.test(source.slice(loop.test.start, loop.test.end))) return undefined;
  if (!pattern.test(source.slice(loop.update.start, loop.update.end))) return undefined;
  return name;
}

function forOfEntriesIndex(loop: ForOfStatement): string | undefined {
  if (loop.right.type !== "CallExpression") return undefined;
  const callee = loop.right.callee;
  if (callee.type !== "MemberExpression" || callee.computed) return undefined;
  if (callee.property.type !== "Identifier" || callee.property.name !== "entries") return undefined;
  const left = loop.left;
  if (left.type !== "VariableDeclaration" || left.declarations.length !== 1) return undefined;
  const id = left.declarations[0]?.id;
  if (!id || id.type !== "ArrayPattern" || id.elements.length === 0) return undefined;
  const first = id.elements[0];
  if (!first || first.type !== "Identifier") return undefined;
  return first.name;
}

function loopIndex(loop: Loop, source: string): string | undefined {
  return loop.type === "ForStatement"
    ? forStatementIndex(loop, source)
    : forOfEntriesIndex(loop);
}

function propertyUse(
  member: MemberExpression,
  index: string,
  source: string,
): "lockstep" | "offset" | "other" {
  if (!member.computed) return "other";
  const property = member.property;
  if (property.type === "Identifier") {
    return property.name === index ? "lockstep" : "other";
  }
  if (property.type === "Super") return "other";
  return new RegExp(`\\b${index}\\b`).test(source.slice(property.start, property.end))
    ? "offset"
    : "other";
}

function lockstepCollectionsIn(
  node: NodeRange,
  members: MemberExpression[],
  index: string,
): Set<string> {
  const names = new Set<string>();
  for (const member of members) {
    if (!containsNode(node, member)) continue;
    if (member.object.type !== "Identifier") continue;
    const property = member.property;
    const isLockstep = member.computed
      && property.type === "Identifier"
      && property.name === index;
    if (isLockstep) names.add(member.object.name);
  }
  return names;
}

export function buildCoupledIndexCollectionsEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): CoupledIndexCollectionsEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  const source = owner.source;
  const nested = nestedFunctionRanges(parsed.program, fn);

  const bindings = new Map<string, ArrayBinding>();
  new Visitor({
    VariableDeclarator(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.id.type !== "Identifier") return;
      if (bindings.has(node.id.name)) return;
      const slice = nodeSource(node, source);
      const initIsArrayLiteral = node.init?.type === "ArrayExpression";
      const initIsNewArray = node.init?.type === "NewExpression"
        && node.init.callee.type === "Identifier"
        && node.init.callee.name === "Array";
      const annotated = ARRAY_TYPE.test(slice);
      if (!initIsArrayLiteral && !initIsNewArray && !annotated) return;
      bindings.set(node.id.name, {
        name: node.id.name,
        provenance: initIsArrayLiteral ? "array-literal" : "array-binding",
        bindingSite: slice.slice(0, 2000),
        elementType: annotationOf(source, node),
        bufferKind: BUFFER_TYPE.test(slice),
        offset: node.start,
      });
    },
  }).visit(parsed.program);
  for (const parameter of fn.params) {
    if (!belongsDirectlyToFunction(parameter, nested)) continue;
    const binding = parameterBinding(source, parameter);
    if (binding && !bindings.has(binding.name)) bindings.set(binding.name, binding);
  }
  if (bindings.size < 2) return undefined;

  const loops: Loop[] = [];
  const addLoop = (loop: Loop): void => {
    if (containsNode(fn, loop) && belongsDirectlyToFunction(loop, nested)) loops.push(loop);
  };
  new Visitor({
    ForOfStatement: addLoop,
    ForStatement: addLoop,
  }).visit(parsed.program);
  loops.sort((left, right) => left.start - right.start);
  if (loops.length === 0) return undefined;

  const members: MemberExpression[] = [];
  const assignments: AssignmentExpression[] = [];
  const updates: UpdateExpression[] = [];
  const records: ObjectExpression[] = [];
  const constructions: Node[] = [];
  new Visitor({
    AssignmentExpression: (node) => {
      if (containsNode(fn, node) && belongsDirectlyToFunction(node, nested)) assignments.push(node);
    },
    MemberExpression: (node) => {
      if (containsNode(fn, node) && belongsDirectlyToFunction(node, nested)) members.push(node);
    },
    NewExpression: (node) => {
      if (containsNode(fn, node) && belongsDirectlyToFunction(node, nested)) constructions.push(node);
    },
    ObjectExpression: (node) => {
      if (containsNode(fn, node) && belongsDirectlyToFunction(node, nested)) records.push(node);
    },
    UpdateExpression: (node) => {
      if (containsNode(fn, node) && belongsDirectlyToFunction(node, nested)) updates.push(node);
    },
  }).visit(parsed.program);

  const isWrite = (member: MemberExpression): boolean =>
    assignments.some((assignment) =>
      assignment.left === member
      || (assignment.left.type === "MemberExpression"
        && assignment.left.start === member.start
        && assignment.left.end === member.end)
    )
    || updates.some((update) =>
      update.argument === member
      || (update.argument.type === "MemberExpression"
        && update.argument.start === member.start
        && update.argument.end === member.end)
    );

  for (const loop of loops) {
    const index = loopIndex(loop, source);
    if (!index) continue;
    const inLoop = members.filter((member) => containsNode(loop, member));
    const lockstep = inLoop.filter((member) =>
      member.object.type === "Identifier"
      && bindings.has(member.object.name)
      && propertyUse(member, index, source) === "lockstep"
    );
    const byCollection = new Map<string, MemberExpression[]>();
    for (const member of lockstep) {
      const root = member.object.type === "Identifier" ? member.object.name : undefined;
      if (!root) continue;
      const group = byCollection.get(root) ?? [];
      group.push(member);
      byCollection.set(root, group);
    }
    const paired = [...byCollection.entries()].sort((left, right) =>
      (left[1][0]?.start ?? 0) - (right[1][0]?.start ?? 0)
    );
    if (paired.length < 2) continue;
    const first = paired[0];
    const second = paired[1];
    if (!first || !second) continue;

    const offset = inLoop.some((member) =>
      member.object.type === "Identifier"
      && (member.object.name === first[0] || member.object.name === second[0])
      && propertyUse(member, index, source) === "offset"
    );
    if (offset) continue;

    const recordUsed = [...records, ...constructions].some((record) => {
      if (!containsNode(loop, record)) return false;
      const names = lockstepCollectionsIn(record, inLoop, index);
      return names.has(first[0]) && names.has(second[0]);
    });
    if (recordUsed) continue;

    const firstBinding = bindings.get(first[0]);
    const secondBinding = bindings.get(second[0]);
    if (!firstBinding || !secondBinding) continue;

    const standalone = (collection: string): string[] => members
      .filter((member) =>
        member.object.type === "Identifier"
        && member.object.name === collection
        && !containsNode(loop, member)
      )
      .slice(0, 5)
      .map((member) => nodeSource(member, source).slice(0, 200));

    const pairedAccesses: CoupledIndexAccess[] = [...first[1], ...second[1]]
      .sort((left, right) => left.start - right.start)
      .slice(0, 8)
      .map((member) => ({
        collection: member.object.type === "Identifier" ? member.object.name : "",
        access: nodeSource(member, source).slice(0, 200),
        kind: isWrite(member) ? ("write" as const) : ("read" as const),
      }));

    return {
      function: {
        name,
        exported: isFunctionExported(parsed.program, fn, name),
        filePath: owner.filePath,
        source: candidate.source,
      },
      collections: [firstBinding, secondBinding].map((binding) => ({
        name: binding.name,
        provenance: binding.provenance,
        bindingSite: binding.bindingSite,
        elementType: binding.elementType,
        bufferKind: binding.bufferKind,
        standaloneUses: standalone(binding.name),
      })),
      sharedIndex: index,
      loop: nodeSource(loop, source),
      pairedAccesses,
      callers: findFunctionCallers(owner.filePath, name, projectFiles),
    };
  }

  return undefined;
}
