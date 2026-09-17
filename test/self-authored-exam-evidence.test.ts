import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildSelfAuthoredExamEvidence } from "../src/evidence/self-authored-exam.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

const smellyRoot = new URL("./fixtures/repositories/self-exam-smelly/", import.meta.url);
const anchoredRoot = new URL("./fixtures/repositories/self-exam-anchored/", import.meta.url);

async function change(
  root: URL,
  filePath: string,
  oldSource: string | null,
  changedLines: SourceFile["changedLines"],
  projectFiles: ProjectFile[],
): Promise<SourceFile> {
  const source = await readFile(new URL(`after/${filePath}`, root), "utf8");
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

describe("self authored exam evidence", () => {
  it("pairs a new implementation with its new test when nothing else anchors it", async () => {
    const projectFiles: ProjectFile[] = [];
    const fee = await change(
      smellyRoot,
      "src/fee.ts",
      await readFile(new URL("before/src/fee.ts", smellyRoot), "utf8"),
      [{ start: 1, end: 1 }, { start: 7, end: 9 }],
      projectFiles,
    );
    const exam = await change(smellyRoot, "test/fee.test.ts", null, [], projectFiles);
    await loadAfter(smellyRoot, "src/discount.ts", projectFiles);

    const evidence = buildSelfAuthoredExamEvidence(
      candidate(fee.filePath),
      [fee, exam],
      projectFiles,
    );
    expect(evidence).toMatchObject({
      pairings: [
        expect.objectContaining({
          implFile: "src/fee.ts",
          testFile: "test/fee.test.ts",
          status: "added",
          touchedDeclarations: ["calculateFee"],
        }),
      ],
      unanchored: ["calculateFee"],
    });
  });

  it("records a pre-existing contract test as an external anchor", async () => {
    const projectFiles: ProjectFile[] = [];
    const fee = await change(
      anchoredRoot,
      "src/fee.ts",
      await readFile(new URL("before/src/fee.ts", anchoredRoot), "utf8"),
      [{ start: 8, end: 8 }],
      projectFiles,
    );
    const exam = await change(anchoredRoot, "test/fee.test.ts", null, [], projectFiles);
    await Promise.all([
      loadAfter(anchoredRoot, "src/discount.ts", projectFiles),
      loadAfter(anchoredRoot, "test/fee.contract.test.ts", projectFiles),
    ]);

    const evidence = buildSelfAuthoredExamEvidence(
      candidate(fee.filePath),
      [fee, exam],
      projectFiles,
    );
    expect(evidence).toMatchObject({
      pairings: [
        expect.objectContaining({
          implFile: "src/fee.ts",
          testFile: "test/fee.test.ts",
          touchedDeclarations: expect.arrayContaining(["calculateFee"]),
          anchors: expect.arrayContaining([
            expect.objectContaining({
              declaration: "calculateFee",
              anchorFiles: ["test/fee.contract.test.ts"],
              preExisting: true,
            }),
          ]),
        }),
      ],
      unanchored: [],
    });
  });

  it("abstains when the change pairs no implementation with a test", async () => {
    const projectFiles: ProjectFile[] = [];
    const fee = await change(
      smellyRoot,
      "src/fee.ts",
      await readFile(new URL("before/src/fee.ts", smellyRoot), "utf8"),
      [{ start: 1, end: 1 }, { start: 7, end: 9 }],
      projectFiles,
    );
    await loadAfter(smellyRoot, "src/discount.ts", projectFiles);

    expect(buildSelfAuthoredExamEvidence(candidate(fee.filePath), [fee], projectFiles))
      .toBeUndefined();
  });
});
