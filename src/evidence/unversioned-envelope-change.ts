import { parseSync } from "oxc-parser";
import type {
  Program,
  TSInterfaceDeclaration,
  TSPropertySignature,
  TSTypeAliasDeclaration,
} from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { findModuleImporters } from "./repository.js";
import type { AbstractionNode, ModuleImporter } from "./repository.js";

const MAX_BREAKS = 8;
const MAX_MEMBER_CHANGES = 8;
const MAX_EXCERPT_CHARS = 400;

const ENVELOPE_NAME_PATTERN =
  /(Result|Event|Message|Payload|Envelope|Response|Request|Notification|Command|Mutation|State|Dto|Contract|Action|Intent)$/i;
const VERSION_FIELD_PATTERN = /^(version|apiVersion|schemaVersion|v\d+|revision)$/i;
const DISCRIMINATOR_FIELD_PATTERN = /^(kind|type|event|eventType|action|topic|name)$/i;
const COMPAT_PATTERN = /migrat|compat|legacy|deprecated|fallback/i;

export type EnvelopeMemberChangeKind =
  | "added-required"
  | "added-optional"
  | "removed"
  | "retyped";

export type EnvelopeMemberChange = {
  member: string;
  kind: EnvelopeMemberChangeKind;
  before: string;
  after: string;
};

export type EnvelopeBreak = {
  filePath: string;
  typeName: string;
  kind: "interface" | "type-alias";
  envelopeLike: boolean;
  before: string;
  after: string;
  memberChanges: EnvelopeMemberChange[];
  consumers: ModuleImporter[];
  versionField: string | null;
  kindDiscriminator: string | null;
  compatibilityShim: boolean;
};

export type UnversionedEnvelopeChangeEvidence = {
  anchorFile: string;
  coverage: {
    totalFiles: number;
    comparedFiles: number;
  };
  envelopeBreaks: EnvelopeBreak[];
};

type EnvelopeMember = {
  name: string;
  optional: boolean;
  typeText: string;
  excerpt: string;
};

function memberName(key: TSPropertySignature["key"]): string | undefined {
  if (key.type !== "Identifier") return undefined;
  return key.name;
}

function envelopeMembers(
  node: AbstractionNode,
  source: string,
): EnvelopeMember[] | undefined {
  if (node.type === "TSInterfaceDeclaration") {
    return node.body.body.flatMap((member): EnvelopeMember[] => {
      if (member.type !== "TSPropertySignature") return [];
      const name = memberName(member.key);
      if (!name) return [];
      const annotation = member.typeAnnotation;
      return [{
        name,
        optional: member.optional === true,
        typeText: annotation
          ? source.slice(annotation.start, annotation.end).slice(0, 200)
          : "",
        excerpt: source.slice(member.start, member.end).slice(0, MAX_EXCERPT_CHARS),
      }];
    });
  }
  if (node.typeAnnotation.type !== "TSTypeLiteral") return undefined;
  return node.typeAnnotation.members.flatMap((member): EnvelopeMember[] => {
    if (member.type !== "TSPropertySignature") return [];
    const name = memberName(member.key);
    if (!name) return [];
    const annotation = member.typeAnnotation;
    return [{
      name,
      optional: member.optional === true,
      typeText: annotation
        ? source.slice(annotation.start, annotation.end).slice(0, 200)
        : "",
      excerpt: source.slice(member.start, member.end).slice(0, MAX_EXCERPT_CHARS),
    }];
  });
}

function declaredTypes(program: Program): Map<string, AbstractionNode> {
  const result = new Map<string, AbstractionNode>();
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (
      (declaration?.type === "TSInterfaceDeclaration"
        || declaration?.type === "TSTypeAliasDeclaration")
      && !result.has(declaration.id.name)
    ) result.set(declaration.id.name, declaration);
  }
  return result;
}

function optionalWeakened(before: string, after: string): boolean {
  const clean = (text: string): string =>
    text.replace(/\s+/g, "").replace(/^\|/, "").replace(/\|$/, "");
  const beforeParts = new Set(clean(before).split("|"));
  const afterParts = new Set(clean(after).split("|"));
  if ([...afterParts].every((part) => beforeParts.has(part))) return true;
  if (afterParts.has("null") || afterParts.has("undefined")) return true;
  return false;
}

function diffMembers(
  before: EnvelopeMember[],
  after: EnvelopeMember[],
): EnvelopeMemberChange[] {
  const result: EnvelopeMemberChange[] = [];
  const beforeByName = new Map(before.map((member) => [member.name, member]));
  const afterByName = new Map(after.map((member) => [member.name, member]));
  for (const [name, afterMember] of afterByName) {
    const beforeMember = beforeByName.get(name);
    if (!beforeMember) {
      result.push({
        member: name,
        kind: afterMember.optional ? "added-optional" : "added-required",
        before: "",
        after: afterMember.excerpt,
      });
    } else if (
      beforeMember.typeText !== afterMember.typeText
      && !optionalWeakened(beforeMember.typeText, afterMember.typeText)
    ) {
      result.push({
        member: name,
        kind: "retyped",
        before: beforeMember.excerpt,
        after: afterMember.excerpt,
      });
    }
  }
  for (const [name, beforeMember] of beforeByName) {
    if (!afterByName.has(name)) {
      result.push({
        member: name,
        kind: "removed",
        before: beforeMember.excerpt,
        after: "",
      });
    }
  }
  return result;
}

export function buildUnversionedEnvelopeChangeEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): UnversionedEnvelopeChangeEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  const envelopeBreaks: EnvelopeBreak[] = [];
  let compared = 0;

  const ordered = [...changes].sort((left, right) => {
    if (left.filePath === candidate.filePath) return -1;
    if (right.filePath === candidate.filePath) return 1;
    return left.filePath.localeCompare(right.filePath);
  });

  for (const change of ordered) {
    if (envelopeBreaks.length >= MAX_BREAKS) break;
    if (change.oldSource === null) continue;
    const beforeParsed = parseSync(change.filePath, change.oldSource, { range: true });
    const afterParsed = parseSync(change.filePath, change.source, { range: true });
    if (
      beforeParsed.errors.some((error) => error.severity === "Error")
      || afterParsed.errors.some((error) => error.severity === "Error")
    ) continue;
    compared += 1;
    const beforeTypes = declaredTypes(beforeParsed.program);
    const afterTypes = declaredTypes(afterParsed.program);

    for (const [name, afterNode] of afterTypes) {
      if (envelopeBreaks.length >= MAX_BREAKS) break;
      const beforeNode = beforeTypes.get(name);
      // Removed or added declarations are export-reshape territory;
      // this rule judges member-level evolution of surviving contracts.
      if (!beforeNode) continue;
      const beforeMembers = envelopeMembers(beforeNode, change.oldSource);
      const afterMembers = envelopeMembers(afterNode, change.source);
      if (beforeMembers === undefined || afterMembers === undefined) continue;
      const memberChanges = diffMembers(beforeMembers, afterMembers);
      if (memberChanges.length === 0) continue;
      const consumers = findModuleImporters(change.filePath, projectFiles);
      // A same-file structural tweak with no outside readers and no
      // message shape is not a contract-evolution question.
      if (!ENVELOPE_NAME_PATTERN.test(name) && consumers.length === 0) continue;
      const aliasKind = (node: TSInterfaceDeclaration | TSTypeAliasDeclaration): "interface" | "type-alias" =>
        node.type === "TSInterfaceDeclaration" ? "interface" : "type-alias";
      envelopeBreaks.push({
        filePath: change.filePath,
        typeName: name,
        kind: aliasKind(afterNode),
        envelopeLike: ENVELOPE_NAME_PATTERN.test(name),
        before: change.oldSource.slice(beforeNode.start, beforeNode.end)
          .slice(0, MAX_EXCERPT_CHARS),
        after: change.source.slice(afterNode.start, afterNode.end)
          .slice(0, MAX_EXCERPT_CHARS),
        memberChanges: memberChanges.slice(0, MAX_MEMBER_CHANGES),
        consumers,
        versionField: afterMembers.find(({ name: member }) =>
          VERSION_FIELD_PATTERN.test(member)
        )?.name ?? null,
        kindDiscriminator: afterMembers.find(({ name: member }) =>
          DISCRIMINATOR_FIELD_PATTERN.test(member)
        )?.name ?? null,
        compatibilityShim: COMPAT_PATTERN.test(change.source)
          || COMPAT_PATTERN.test(change.oldSource),
      });
    }
  }

  if (envelopeBreaks.length === 0) return undefined;
  return {
    anchorFile: candidate.filePath,
    coverage: {
      totalFiles: changes.length,
      comparedFiles: compared,
    },
    envelopeBreaks,
  };
}
