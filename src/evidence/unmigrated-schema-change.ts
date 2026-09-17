import { parseSync, Visitor } from "oxc-parser";
import type { Program } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
export type SchemaEditKind =
  | "added-required-field"
  | "removed-field"
  | "optional-to-required"
  | "narrowed-type";

export type SchemaEdit = {
  filePath: string;
  member: string;
  kind: SchemaEditKind;
  before: string | null;
  after: string | null;
};

export type UnmigratedSchemaChangeEvidence = {
  anchorFile: string;
  coverage: {
    totalFiles: number;
    comparedFiles: number;
  };
  schemaEdits: SchemaEdit[];
  migrationInChange: string[];
  backfillOrDefaultInChange: boolean;
  repoMigrates: boolean;
};

type MemberSignature = {
  name: string;
  optional: boolean;
  typeText: string;
};

const MIGRATION_FILE_PATTERN = /(^|\/)migrations?(\/|_|\.)|drizzle\/|prisma\/migrations|knex|alembic|typeorm.*migration|\.sql$|migration\.[cm]?[jt]s$/i;
const MODEL_FILE_PATTERN = /model|schema|entity|prisma\/schema|drizzle\/schema/i;
const BACKFILL_PATTERN = /backfill|default\s*[:=]|allowNull\s*:\s*false|onUpdate|upsert/i;

function memberSignatures(program: Program, source: string): Map<string, MemberSignature> {
  const result = new Map<string, MemberSignature>();
  const add = (name: string | undefined, optional: boolean, typeText: string): void => {
    if (name && !result.has(name)) result.set(name, { name, optional, typeText });
  };
  new Visitor({
    TSInterfaceDeclaration(node) {
      for (const member of node.body.body) {
        if (member.type !== "TSPropertySignature") continue;
        const key = member.key;
        const name = key.type === "Identifier" ? key.name : undefined;
        add(
          name,
          member.optional ?? false,
          member.typeAnnotation ? source.slice(member.typeAnnotation.start, member.typeAnnotation.end) : "",
        );
      }
    },
    TSTypeLiteral(node) {
      for (const member of node.members) {
        if (member.type !== "TSPropertySignature") continue;
        const key = member.key;
        const name = key.type === "Identifier" ? key.name : undefined;
        add(
          name,
          member.optional ?? false,
          member.typeAnnotation ? source.slice(member.typeAnnotation.start, member.typeAnnotation.end) : "",
        );
      }
    },
    PropertyDefinition(node) {
      const key = node.key;
      const name = key.type === "Identifier" ? key.name : undefined;
      if (!name || node.computed) return;
      add(
        name,
        node.optional ?? false,
        node.typeAnnotation ? source.slice(node.typeAnnotation.start, node.typeAnnotation.end) : "",
      );
    },
  }).visit(program);
  return result;
}

function narrowed(before: string, after: string): boolean {
  const clean = (text: string): string => text.replace(/^:\s*/, "").trim();
  const from = clean(before);
  const to = clean(after);
  if (from === to) return false;
  if (/any|unknown/.test(from) && !/any|unknown/.test(to)) return true;
  const fromOptions = from.split("|").map((part) => part.trim()).filter(Boolean);
  const toOptions = to.split("|").map((part) => part.trim()).filter(Boolean);
  if (fromOptions.length > 1 && toOptions.length >= 1) {
    return toOptions.every((option) => fromOptions.includes(option))
      && toOptions.length < fromOptions.length;
  }
  if (/string|number/.test(from) && /^["']/.test(to)) return true;
  return false;
}

export function buildUnmigratedSchemaChangeEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): UnmigratedSchemaChangeEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  const schemaEdits: SchemaEdit[] = [];
  const migrationInChange: string[] = [];
  let backfillOrDefaultInChange = false;
  let compared = 0;

  for (const change of changes) {
    if (MIGRATION_FILE_PATTERN.test(change.filePath)) {
      migrationInChange.push(change.filePath);
    }
    if (BACKFILL_PATTERN.test(change.source)) backfillOrDefaultInChange = true;
    if (change.oldSource === null) continue;
    if (!MODEL_FILE_PATTERN.test(change.filePath) && change.filePath !== candidate.filePath) {
      const touchesModel = /interface\s+\w+|type\s+\w+\s*=|@Entity|@Table|schema\.|defineModel/i
        .test(change.source);
      if (!touchesModel) continue;
    }
    const beforeParsed = parseSync(change.filePath, change.oldSource, { range: true });
    const afterParsed = parseSync(change.filePath, change.source, { range: true });
    if (
      beforeParsed.errors.some((error) => error.severity === "Error")
      || afterParsed.errors.some((error) => error.severity === "Error")
    ) continue;
    compared += 1;
    const before = memberSignatures(beforeParsed.program, change.oldSource);
    const after = memberSignatures(afterParsed.program, change.source);

    for (const [name, afterSig] of after) {
      if (schemaEdits.length >= 10) break;
      const beforeSig = before.get(name);
      if (!beforeSig) {
        if (!afterSig.optional) {
          schemaEdits.push({
            filePath: change.filePath,
            member: name,
            kind: "added-required-field",
            before: null,
            after: afterSig.typeText.slice(0, 200),
          });
        }
        continue;
      }
      if (beforeSig.optional && !afterSig.optional) {
        schemaEdits.push({
          filePath: change.filePath,
          member: name,
          kind: "optional-to-required",
          before: beforeSig.typeText.slice(0, 200),
          after: afterSig.typeText.slice(0, 200),
        });
      } else if (narrowed(beforeSig.typeText, afterSig.typeText)) {
        schemaEdits.push({
          filePath: change.filePath,
          member: name,
          kind: "narrowed-type",
          before: beforeSig.typeText.slice(0, 200),
          after: afterSig.typeText.slice(0, 200),
        });
      }
    }
    for (const [name, beforeSig] of before) {
      if (schemaEdits.length >= 10) break;
      if (!after.has(name)) {
        schemaEdits.push({
          filePath: change.filePath,
          member: name,
          kind: "removed-field",
          before: beforeSig.typeText.slice(0, 200),
          after: null,
        });
      }
    }
  }

  if (schemaEdits.length === 0) return undefined;

  const repoMigrates = projectFiles.some(({ filePath }) => MIGRATION_FILE_PATTERN.test(filePath))
    || projectFiles.some(({ source }) =>
      /createMigration|addMigration|migration\(|up\s*[:=]\s*async|migrate\(/i.test(source)
    );
  if (!repoMigrates) return undefined;

  return {
    anchorFile: candidate.filePath,
    coverage: { totalFiles: changes.length, comparedFiles: compared },
    schemaEdits,
    migrationInChange,
    backfillOrDefaultInChange,
    repoMigrates,
  };
}
