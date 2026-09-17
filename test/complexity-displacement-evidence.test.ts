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
          coverage: {
            before: {
              totalChars: changes[0]?.oldSource?.length,
              includedChars: (changes[0]?.oldSource?.length ?? 0) - 1,
              omittedChars: 1,
              totalDeclarations: 1,
              includedDeclarations: 1,
              omittedDeclarations: 0,
              truncatedDeclarations: 0,
            },
            after: expect.objectContaining({
              totalChars: changes[0]?.source.length,
              omittedChars: 3,
              totalDeclarations: 2,
              includedDeclarations: 2,
              omittedDeclarations: 0,
            }),
          },
        }),
        expect.objectContaining({
          filePath: "src/signup.ts",
          after: expect.stringContaining("normalizeEmail"),
        }),
      ],
      coverage: expect.objectContaining({
        totalFiles: 2,
        includedFiles: 2,
        omittedFiles: 0,
        includedFilePaths: ["src/register-user.ts", "src/signup.ts"],
        omittedFilePaths: [],
        unlistedOmittedFiles: 0,
      }),
      callerChanges: expect.arrayContaining([
        expect.objectContaining({
          functionName: "registerUser",
          before: expect.objectContaining({
            total: 1,
            included: 1,
            omitted: 0,
            callers: [expect.objectContaining({ call: "registerUser(form)" })],
          }),
          after: expect.objectContaining({
            total: 1,
            included: 1,
            omitted: 0,
            callers: [expect.objectContaining({ call: expect.stringContaining("registerUser({") })],
          }),
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
