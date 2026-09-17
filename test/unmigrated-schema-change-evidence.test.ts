import { describe, expect, it } from "vitest";
import { buildUnmigratedSchemaChangeEvidence } from "../src/evidence/unmigrated-schema-change.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

const before = `export interface Customer {
  id: string;
  name?: string;
}
`;

const afterTightened = `export interface Customer {
  id: string;
  name?: string;
  email: string;
}
`;

const afterNullable = `export interface Customer {
  id: string;
  name?: string;
  email?: string;
}
`;

const migrationFile: SourceFile = {
  filePath: "migrations/004-add-email.sql",
  source: `ALTER TABLE customers ADD COLUMN email TEXT NOT NULL DEFAULT '';`,
  oldSource: null,
  changedLines: [{ start: 1, end: 1 }],
};

function candidate(filePath: string): Candidate {
  return {
    id: "change_0",
    kind: "change",
    filePath,
    source: "Whole change. Use the rule-specific before/after evidence.",
    start: 0,
    end: 1,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  };
}

type ChangeScenario = {
  changes: SourceFile[];
  projectFiles: ProjectFile[];
};

function scenario(after: string, extra: SourceFile[] = []): ChangeScenario {
  const changes: SourceFile[] = [{
    filePath: "src/models/customer.ts",
    source: after,
    oldSource: before,
    changedLines: [{ start: 1, end: 5 }],
  }, ...extra];
  const projectFiles: ProjectFile[] = [
    { filePath: "src/models/customer.ts", source: after },
    { filePath: "migrations/003-backfill.sql", source: `UPDATE customers SET name = '' WHERE name IS NULL;` },
  ];
  return { changes, projectFiles };
}

describe("unmigrated schema change evidence", () => {
  it("extracts an added required field with no migration in the change", () => {
    const { changes, projectFiles } = scenario(afterTightened);
    const evidence = buildUnmigratedSchemaChangeEvidence(
      candidate("src/models/customer.ts"),
      changes,
      projectFiles,
    );

    expect(evidence).toMatchObject({
      schemaEdits: [{ member: "email", kind: "added-required-field" }],
      migrationInChange: [],
      repoMigrates: true,
    });
  });

  it("records a migration shipped in the same change", () => {
    const { changes, projectFiles } = scenario(afterTightened, [migrationFile]);
    const evidence = buildUnmigratedSchemaChangeEvidence(
      candidate("src/models/customer.ts"),
      changes,
      projectFiles,
    );

    expect(evidence?.migrationInChange).toContain("migrations/004-add-email.sql");
  });

  it("abstains on additive nullable fields", () => {
    const { changes, projectFiles } = scenario(afterNullable);
    expect(buildUnmigratedSchemaChangeEvidence(
      candidate("src/models/customer.ts"),
      changes,
      projectFiles,
    )).toBeUndefined();
  });

  it("abstains in a greenfield repository with no migration precedent", () => {
    const changes: SourceFile[] = [{
      filePath: "src/models/customer.ts",
      source: afterTightened,
      oldSource: before,
      changedLines: [{ start: 1, end: 5 }],
    }];
    expect(buildUnmigratedSchemaChangeEvidence(
      candidate("src/models/customer.ts"),
      changes,
      [{ filePath: "src/models/customer.ts", source: afterTightened }],
    )).toBeUndefined();
  });
});
