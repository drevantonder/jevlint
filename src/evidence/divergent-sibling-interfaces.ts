import { parseSync, Visitor } from "oxc-parser";
import type { CallExpression, Class, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { moduleImports, resolveModule } from "./repository.js";

const MAX_SIBLINGS = 6;
const MAX_MEMBERS_PER_SIBLING = 20;
const MAX_ANALOGOUS_PAIRS = 12;
const MAX_SHARED_CLIENTS = 6;
const MAX_CALL_CHARS = 240;

type MemberSignature = {
  name: string;
  kind: string;
  arity: number;
  params: string;
};

type SiblingEvidence = {
  name: string;
  filePath: string;
  relationship: string;
  members: MemberSignature[];
  membersTruncated: boolean;
};

export type AnalogousPairEvidence = {
  candidateMember: string;
  candidateArity: number;
  sibling: string;
  siblingMember: string;
  siblingArity: number;
  sameArity: boolean;
};

export type SharedClientEvidence = {
  filePath: string;
  siblingCalls: string[];
};

export type DivergentSiblingInterfacesEvidence = {
  class: {
    name: string;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  relationship: {
    kind: "superclass" | "interface" | "union-case" | "same-module";
    reference: string;
  };
  members: MemberSignature[];
  siblings: SiblingEvidence[];
  analogousPairs: AnalogousPairEvidence[];
  sharedClients: SharedClientEvidence[];
  sharedImportSources: string[];
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

function memberKey(member: Class["body"]["body"][number]): string | undefined {
  if (member.type !== "MethodDefinition" && member.type !== "PropertyDefinition") return undefined;
  if (member.type === "MethodDefinition" && member.computed) return undefined;
  const key = member.key;
  if (key.type === "Identifier") return key.name;
  if (key.type === "PrivateIdentifier") return `#${key.name}`;
  return undefined;
}

function signatures(
  node: Class,
  source: string,
  limit: number,
): MemberInventory {
  const all: MemberSignature[] = [];
  for (const member of node.body.body) {
    if (member.type === "MethodDefinition") {
      const name = memberKey(member);
      if (!name || name === "constructor" || name.startsWith("#")) continue;
      const params = member.value.type === "FunctionExpression"
        ? member.value.params.map((param) => source.slice(param.start, param.end).slice(0, 120))
        : [];
      all.push({
        name,
        kind: member.kind,
        arity: params.length,
        params: params.join(", "),
      });
    } else if (member.type === "PropertyDefinition") {
      const name = memberKey(member);
      if (!name || name.startsWith("#")) continue;
      all.push({ name, kind: "property", arity: 0, params: "" });
    }
  }
  return { members: all.slice(0, limit), truncated: all.length > limit };
}

type MemberInventory = {
  members: MemberSignature[];
  truncated: boolean;
};

type Heritage = {
  superClass: string | null;
  interfaces: string[];
};

function heritageNames(node: Class): Heritage {
  const superClass = node.superClass?.type === "Identifier" ? node.superClass.name : null;
  const interfaces = (node.implements ?? []).flatMap(({ expression }) =>
    expression.type === "Identifier" ? [expression.name] : []
  );
  return { superClass, interfaces };
}

type KnownClass = {
  name: string;
  filePath: string;
  node: Class;
  source: string;
  superClass: string | null;
  interfaces: string[];
};

function knownClasses(projectFiles: ProjectFile[]): KnownClass[] {
  const result: KnownClass[] = [];
  for (const file of projectFiles) {
    const parsed = parseSync(file.filePath, file.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    new Visitor({
      ClassDeclaration(node) {
        const name = node.id?.name;
        if (!name) return;
        const heritage = heritageNames(node);
        result.push({
          name,
          filePath: file.filePath,
          node,
          source: file.source,
          superClass: heritage.superClass,
          interfaces: heritage.interfaces,
        });
      },
    }).visit(parsed.program);
  }
  return result;
}

function unionCaseSiblings(
  candidateName: string,
  projectFiles: ProjectFile[],
  known: KnownClass[],
): string[] {
  const byName = new Map(known.map((item) => [item.name, item]));
  const siblings = new Set<string>();
  for (const file of projectFiles) {
    const parsed = parseSync(file.filePath, file.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    new Visitor({
      TSTypeAliasDeclaration(node) {
        const text = file.source.slice(node.start, node.end);
        if (!text.includes(candidateName)) return;
        for (const name of byName.keys()) {
          if (name !== candidateName && text.includes(name)) siblings.add(name);
        }
      },
    }).visit(parsed.program);
  }
  return [...siblings];
}

function relationshipKind(
  reference: string,
): DivergentSiblingInterfacesEvidence["relationship"]["kind"] {
  if (reference.startsWith("extends")) return "superclass";
  if (reference.startsWith("implements")) return "interface";
  if (reference === "union-case") return "union-case";
  return "same-module";
}

function sharedClients(
  names: string[],
  memberNames: Set<string>,
  projectFiles: ProjectFile[],
): SharedClientEvidence[] {
  const result: SharedClientEvidence[] = [];
  for (const file of projectFiles) {
    const parsed = parseSync(file.filePath, file.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const imports = moduleImports(parsed.program);
    const touched = new Set<string>();
    for (const imported of imports) {
      const resolved = resolveModule(file.filePath, imported.source, projectFiles);
      if (!resolved) continue;
      if (names.includes(imported.imported)) touched.add(imported.imported);
    }
    if (touched.size < 2) continue;
    const calls: string[] = [];
    new Visitor({
      CallExpression(call: CallExpression) {
        const callee = call.callee;
        if (callee.type !== "MemberExpression" || callee.computed) return;
        if (callee.property.type !== "Identifier" || !memberNames.has(callee.property.name)) return;
        if (calls.length < 4) calls.push(file.source.slice(call.start, call.end).slice(0, MAX_CALL_CHARS));
      },
    }).visit(parsed.program);
    result.push({ filePath: file.filePath, siblingCalls: calls });
    if (result.length >= MAX_SHARED_CLIENTS) break;
  }
  return result;
}

export function buildDivergentSiblingInterfacesEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DivergentSiblingInterfacesEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const node = findClass(parsed.program, candidate);
  if (!node) return undefined;
  const name = node.id?.name;
  if (!name) return undefined;

  const { members } = signatures(node, owner.source, MAX_MEMBERS_PER_SIBLING);
  if (members.length === 0) return undefined;

  const heritage = heritageNames(node);
  const known = knownClasses(projectFiles).filter((item) =>
    !(item.filePath === owner.filePath && item.name === name)
  );
  const siblingNames = new Map<string, string>();
  for (const item of known) {
    if (heritage.superClass && item.superClass === heritage.superClass) {
      siblingNames.set(item.name, `extends ${heritage.superClass}`);
    } else if (heritage.interfaces.some((face) => item.interfaces.includes(face))) {
      const shared = heritage.interfaces.find((face) => item.interfaces.includes(face));
      siblingNames.set(item.name, `implements ${shared}`);
    }
  }
  if (siblingNames.size === 0) {
    for (const unionName of unionCaseSiblings(name, projectFiles, known)) {
      siblingNames.set(unionName, "union-case");
    }
  }
  if (siblingNames.size === 0) {
    for (const item of known) {
      if (item.filePath === owner.filePath) siblingNames.set(item.name, "same-module");
    }
  }
  if (siblingNames.size === 0) return undefined;

  const byName = new Map(known.map((item) => [item.name, item]));
  const siblings: SiblingEvidence[] = [...siblingNames]
    .slice(0, MAX_SIBLINGS)
    .flatMap(([siblingName, relationship]): SiblingEvidence[] => {
      const item = byName.get(siblingName);
      if (!item) return [];
      const { members: siblingMembers, truncated } = signatures(item.node, item.source, MAX_MEMBERS_PER_SIBLING);
      if (siblingMembers.length === 0) return [];
      return [{
        name: siblingName,
        filePath: item.filePath,
        relationship,
        members: siblingMembers,
        membersTruncated: truncated,
      }];
    });
  if (siblings.length === 0) return undefined;

  const analogousPairs: AnalogousPairEvidence[] = [];
  outer: for (const member of members) {
    for (const sibling of siblings) {
      for (const other of sibling.members) {
        const sameName = other.name === member.name;
        const sameArity = other.arity === member.arity;
        if ((!sameName && sameArity) || (sameName && !sameArity)) {
          analogousPairs.push({
            candidateMember: member.name,
            candidateArity: member.arity,
            sibling: sibling.name,
            siblingMember: other.name,
            siblingArity: other.arity,
            sameArity,
          });
          if (analogousPairs.length >= MAX_ANALOGOUS_PAIRS) break outer;
        }
      }
    }
  }
  if (analogousPairs.length === 0) return undefined;

  const allNames = [name, ...siblings.map(({ name: siblingName }) => siblingName)];
  const memberNames = new Set([
    ...members.map(({ name: memberName }) => memberName),
    ...siblings.flatMap(({ members: siblingMembers }) => siblingMembers.map(({ name: memberName }) => memberName)),
  ]);
  const ownerImports = new Set(moduleImports(parsed.program).map(({ source }) => source));
  const sharedImportSources = [...new Set(siblings.flatMap(({ filePath }) => {
    const file = projectFiles.find(({ filePath: path }) => path === filePath);
    if (!file) return [];
    const reparsed = parseSync(file.filePath, file.source, { range: true });
    if (reparsed.errors.some((error) => error.severity === "Error")) return [];
    return moduleImports(reparsed.program)
      .filter(({ source }) => ownerImports.has(source))
      .map(({ source }) => source);
  }))].slice(0, 12);

  const [first] = [...siblingNames.values()];
  const reference = first ?? "unknown";
  return {
    class: {
      name,
      filePath: owner.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    relationship: {
      kind: relationshipKind(reference),
      reference,
    },
    members,
    siblings,
    analogousPairs,
    sharedClients: sharedClients(allNames, memberNames, projectFiles),
    sharedImportSources,
  };
}
