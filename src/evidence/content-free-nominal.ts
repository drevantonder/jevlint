import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type {
  Class,
  Function as OxcFunction,
  MethodDefinition,
  Program,
  PropertyDefinition,
  TSInterfaceDeclaration,
  TSSignature,
  TSTypeAliasDeclaration,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";

export type NominalMember = {
  name: string;
  kind: "method" | "get" | "set" | "field";
  touches: string[];
  signatureOnly: boolean;
};

export type ContentFreeNominalEvidence = {
  abstraction: {
    name: string;
    kind: "class" | "interface" | "type";
    suffix: string;
    filePath: string;
    source: string;
  };
  members: {
    fields: string[];
    methods: NominalMember[];
    bodiesAvailable: boolean;
  };
  cohesion: {
    methodCount: number;
    fieldCount: number;
    sharedFields: string[];
    isolatedMethods: string[];
  };
};

/** Closed mechanical pre-filter: terminal nominals that promise no domain role. */
const CONTENT_FREE_NOMINALS = new Map([
  ["manager", "Manager"],
  ["helper", "Helper"],
  ["util", "Util"],
  ["utils", "Utils"],
  ["handler", "Handler"],
  ["processor", "Processor"],
  ["data", "Data"],
  ["info", "Info"],
]);

function matchNominal(name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [suffix, display] of CONTENT_FREE_NOMINALS) {
    if (!lower.endsWith(suffix)) continue;
    const cut = name.length - suffix.length;
    if (cut === 0) return display;
    const prev = name[cut - 1] ?? "";
    const curr = name[cut] ?? "";
    const isLower = (char: string): boolean => char !== char.toUpperCase() && char === char.toLowerCase();
    const isUpper = (char: string): boolean => char !== char.toLowerCase() && char === char.toUpperCase();
    // Whole-name, separator, camel (UserManager), or acronym (URLInfo) boundary.
    // A lowercase-to-lowercase join (Metadata) is one token, not a suffix.
    if (cut === 0 || prev === "_" || prev === "$" || /[0-9]/.test(prev)) return display;
    if (isLower(prev) && isUpper(curr)) return display;
    if (!isLower(prev)) return display;
  }
  return undefined;
}

function findDeclaration(
  program: Program,
  candidate: Candidate,
):
  | { node: Class; kind: "class" }
  | { node: TSInterfaceDeclaration; kind: "interface" }
  | { node: TSTypeAliasDeclaration; kind: "type" }
  | undefined {
  let result:
    | { node: Class; kind: "class" }
    | { node: TSInterfaceDeclaration; kind: "interface" }
    | { node: TSTypeAliasDeclaration; kind: "type" }
    | undefined;
  new Visitor({
    ClassDeclaration(node) {
      if (node.start === candidate.start && node.end === candidate.end) {
        result = { node, kind: "class" };
      }
    },
    TSInterfaceDeclaration(node) {
      if (node.start === candidate.start && node.end === candidate.end) {
        result = { node, kind: "interface" };
      }
    },
    TSTypeAliasDeclaration(node) {
      if (node.start === candidate.start && node.end === candidate.end) {
        result = { node, kind: "type" };
      }
    },
  }).visit(program);
  return result;
}

function memberKeyName(key: MethodDefinition["key"] | PropertyDefinition["key"]): string | undefined {
  if (key.type === "Identifier") return key.name;
  if (key.type === "PrivateIdentifier") return `#${key.name}`;
  return undefined;
}

type FunctionRange = {
  start: number;
  end: number;
};

function inRange(range: FunctionRange, start: number, end: number): boolean {
  return range.start <= start && end <= range.end;
}

const THIS_ACCESS = /^this(\?\.)?\.\s*(#?[A-Za-z_$][\w$]*)/;

function collectThisTouches(
  value: OxcFunction,
  ownerSource: string,
  program: Program,
): string[] {
  const scope: FunctionRange = { start: value.start, end: value.end };
  const nested: FunctionRange[] = [];
  const touches: string[] = [];
  const recordFunction = (start: number, end: number): void => {
    if (inRange(scope, start, end) && !(start === value.start && end === value.end)) {
      nested.push({ start, end });
    }
  };
  new Visitor({
    ArrowFunctionExpression(node) {
      recordFunction(node.start, node.end);
    },
    FunctionDeclaration(node) {
      recordFunction(node.start, node.end);
    },
    FunctionExpression(node) {
      recordFunction(node.start, node.end);
    },
    MemberExpression(node) {
      if (!inRange(scope, node.start, node.end)) return;
      if (nested.some((range) => inRange(range, node.start, node.end))) return;
      const match = THIS_ACCESS.exec(ownerSource.slice(node.start, node.end));
      if (match?.[2]) touches.push(match[2]);
    },
  }).visit(program);
  return [...new Set(touches)].sort();
}

function classMembers(node: Class, ownerSource: string, program: Program): NominalMember[] {
  const members: NominalMember[] = [];
  for (const element of node.body.body) {
    if (element.type === "MethodDefinition") {
      if (element.kind === "constructor" || element.static) continue;
      const name = memberKeyName(element.key) ?? "computed";
      if (name === "computed") continue;
      const body = element.value.body;
      members.push({
        name,
        kind: element.kind,
        touches: body ? collectThisTouches(element.value, ownerSource, program) : [],
        signatureOnly: !body,
      });
      continue;
    }
    if (element.type === "PropertyDefinition") {
      if (element.static) continue;
      const name = memberKeyName(element.key);
      if (!name) continue;
      members.push({ name, kind: "field", touches: [], signatureOnly: true });
    }
  }
  return members;
}

function signatureMembers(
  members: Array<TSSignature>,
): NominalMember[] {
  const result: NominalMember[] = [];
  for (const member of members) {
    if (member.type !== "TSPropertySignature" && member.type !== "TSMethodSignature") continue;
    if (member.computed || member.key.type !== "Identifier") continue;
    result.push({
      name: member.key.name,
      kind: member.type === "TSMethodSignature" ? "method" : "field",
      touches: [],
      signatureOnly: true,
    });
  }
  return result;
}

export function buildContentFreeNominalEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ContentFreeNominalEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const declaration = findDeclaration(parsed.program, candidate);
  if (!declaration) return undefined;

  const name = declaration.node.id?.name;
  if (!name) return undefined;
  const suffix = matchNominal(name);
  if (!suffix) return undefined;

  const members = declaration.kind === "class"
    ? classMembers(declaration.node, owner.source, parsed.program)
    : declaration.kind === "interface"
      ? signatureMembers(declaration.node.body.body)
      : declaration.node.typeAnnotation.type === "TSTypeLiteral"
        ? signatureMembers(declaration.node.typeAnnotation.members)
        : [];
  if (members.length === 0) return undefined;

  const fields = members.filter(({ kind }) => kind === "field").map(({ name: field }) => field);
  const methods = members.filter(({ kind }) => kind !== "field");
  const bodiesAvailable = methods.some(({ signatureOnly }) => !signatureOnly);

  const touchCounts = new Map<string, number>();
  for (const method of methods) {
    for (const touch of new Set(method.touches)) {
      touchCounts.set(touch, (touchCounts.get(touch) ?? 0) + 1);
    }
  }
  const shared = new Set(
    [...touchCounts].filter(([, count]) => count >= 2).map(([touch]) => touch),
  );
  const sharedFields = [...shared].sort().slice(0, 20);
  const isolatedMethods = methods
    .filter(({ touches }) => touches.every((touch) => !shared.has(touch)))
    .map(({ name: method }) => method)
    .slice(0, 30);

  return {
    abstraction: {
      name,
      kind: declaration.kind,
      suffix,
      filePath: owner.filePath,
      source: candidate.source,
    },
    members: {
      fields: fields.slice(0, 40),
      methods: methods.slice(0, 30),
      bodiesAvailable,
    },
    cohesion: {
      methodCount: methods.length,
      fieldCount: fields.length,
      sharedFields,
      isolatedMethods,
    },
  };
}
