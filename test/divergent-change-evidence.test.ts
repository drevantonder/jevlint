import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildDivergentChangeEvidence } from "../src/evidence/divergent-change.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

const smellyRoot = new URL("./fixtures/repositories/divergent-change-smelly/", import.meta.url);
const cohesiveRoot = new URL("./fixtures/repositories/divergent-change-cohesive/", import.meta.url);

async function change(
  root: URL,
  filePath: string,
  changedLines: SourceFile["changedLines"],
  projectFiles: ProjectFile[],
): Promise<SourceFile> {
  const [oldSource, source] = await Promise.all([
    readFile(new URL(`before/${filePath}`, root), "utf8"),
    readFile(new URL(`after/${filePath}`, root), "utf8"),
  ]);
  projectFiles.push({ filePath, source });
  return { filePath, oldSource, source, changedLines };
}

async function loadAfter(root: URL, filePath: string, projectFiles: ProjectFile[]): Promise<void> {
  projectFiles.push({
    filePath,
    source: await readFile(new URL(`after/${filePath}`, root), "utf8"),
  });
}

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

describe("divergent change evidence", () => {
  it("maps same-file hunks to disjoint member sets with distinct callers", async () => {
    const projectFiles: ProjectFile[] = [];
    const account = await change(
      smellyRoot,
      "src/account.ts",
      [{ start: 6, end: 6 }, { start: 15, end: 15 }],
      projectFiles,
    );
    await Promise.all([
      loadAfter(smellyRoot, "src/profile.ts", projectFiles),
      loadAfter(smellyRoot, "src/billing.ts", projectFiles),
    ]);
    const evidence = buildDivergentChangeEvidence(candidate(account.filePath), [account], projectFiles);

    expect(evidence).toMatchObject({
      anchorFile: "src/account.ts",
      modules: [
        expect.objectContaining({
          filePath: "src/account.ts",
          status: "modified",
          selection: "anchor",
          hunks: [
            {
              startLine: 6,
              endLine: 6,
              declarations: ["Account.rename"],
              identifiers: ["name", "toLowerCase", "trim"],
            },
            {
              startLine: 15,
              endLine: 15,
              declarations: ["formatCents"],
              identifiers: ["cents", "toFixed"],
            },
          ],
          disjointHunks: true,
          crossHunkIdentifiers: [],
        }),
      ],
    });
    const touched = evidence?.modules[0]?.touchedDeclarations ?? [];
    expect(touched.map(({ name }) => name).sort()).toEqual([
      "Account.rename",
      "formatCents",
    ]);
    expect(touched).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "Account.rename",
          callerFiles: ["src/profile.ts"],
        }),
        expect.objectContaining({
          name: "formatCents",
          callerFiles: ["src/billing.ts"],
        }),
      ]),
    );
  });

  it("shares an identifier across hunks for a single feature", async () => {
    const projectFiles: ProjectFile[] = [];
    const account = await change(
      cohesiveRoot,
      "src/account.ts",
      [{ start: 3, end: 7 }, { start: 14, end: 14 }],
      projectFiles,
    );
    const evidence = buildDivergentChangeEvidence(candidate(account.filePath), [account], projectFiles);

    expect(evidence?.modules[0]).toMatchObject({
      disjointHunks: true,
      crossHunkIdentifiers: ["frozen"],
      touchedDeclarations: expect.arrayContaining([
        expect.objectContaining({ name: "Account.freeze" }),
        expect.objectContaining({ name: "Account.withdraw" }),
      ]),
    });
  });

  it("abstains for single-hunk and function-scoped candidates", async () => {
    const projectFiles: ProjectFile[] = [];
    const account = await change(
      smellyRoot,
      "src/account.ts",
      [{ start: 6, end: 6 }],
      projectFiles,
    );
    expect(buildDivergentChangeEvidence(candidate(account.filePath), [account], projectFiles))
      .toBeUndefined();
    expect(buildDivergentChangeEvidence(
      { ...candidate(account.filePath), kind: "function" },
      [account],
      projectFiles,
    )).toBeUndefined();
  });
});
