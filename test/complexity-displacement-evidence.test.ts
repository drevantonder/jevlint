import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildComplexityDisplacementEvidence } from "../src/evidence/complexity-displacement.js";
import type { Candidate, SourceFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/complexity-displacement-smelly/", import.meta.url);

async function change(filePath: string): Promise<SourceFile> {
  const [oldSource, source] = await Promise.all([
    readFile(new URL(`before/${filePath}`, root), "utf8"),
    readFile(new URL(`after/${filePath}`, root), "utf8"),
  ]);
  return {
    filePath,
    oldSource,
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
  };
}

function candidate(file: SourceFile): Candidate {
  return {
    id: "change_0",
    kind: "change",
    filePath: file.filePath,
    source: file.source,
    start: 0,
    end: file.source.length,
    startLine: 1,
    startColumn: 1,
    endLine: file.source.split("\n").length,
    endColumn: 1,
  };
}

describe("complexity displacement evidence", () => {
  it("presents before and after declarations across the whole change", async () => {
    const changes = await Promise.all([change("src/register-user.ts"), change("src/signup.ts")]);
    const evidence = buildComplexityDisplacementEvidence(candidate(changes[0]!), changes);

    expect(evidence).toMatchObject({
      anchorFile: "src/register-user.ts",
      files: [
        expect.objectContaining({
          filePath: "src/register-user.ts",
          before: expect.stringContaining("registerUser(input"),
          after: expect.stringContaining("RegistrationSteps"),
          beforeDeclarations: [expect.objectContaining({ name: "registerUser" })],
          afterDeclarations: expect.arrayContaining([
            expect.objectContaining({ name: "RegistrationSteps" }),
            expect.objectContaining({ name: "registerUser" }),
          ]),
        }),
        expect.objectContaining({
          filePath: "src/signup.ts",
          after: expect.stringContaining("normalizeEmail"),
        }),
      ],
      callerChanges: expect.arrayContaining([
        expect.objectContaining({
          functionName: "registerUser",
          before: [expect.objectContaining({ call: "registerUser(form)" })],
          after: [expect.objectContaining({ call: expect.stringContaining("registerUser({") })],
        }),
      ]),
    });
  });

  it("requires before-and-after evidence", () => {
    const added: SourceFile = {
      filePath: "src/new.ts",
      oldSource: null,
      source: "export const value = 1;",
      changedLines: [{ start: 1, end: 1 }],
    };
    expect(buildComplexityDisplacementEvidence(candidate(added), [added])).toBeUndefined();
  });
});
