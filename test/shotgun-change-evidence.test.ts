import { describe, expect, it } from "vitest";
import { buildShotgunChangeEvidence } from "../src/evidence/shotgun-change.js";
import type { Candidate, SourceFile } from "../src/types.js";

function candidate(filePath: string): Candidate {
  return {
    id: "change_0",
    kind: "change",
    filePath,
    source: "Whole change across 3 files.",
    start: 0,
    end: 24,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  };
}

function change(filePath: string, source: string, changedLines: { start: number; end: number }[]): SourceFile {
  return { filePath, source, oldSource: source, changedLines };
}

const HANDLER_A = "import { checkCapability } from \"./capabilities.js\";\n"
  + "export function handleA(user: string): void {\n"
  + "  if (!checkCapability(user, \"export\")) throw new Error(\"denied\");\n"
  + "}\n";
const HANDLER_B = "import { checkCapability } from \"./capabilities.js\";\n"
  + "export function handleB(user: string): void {\n"
  + "  if (!checkCapability(user, \"export\")) throw new Error(\"denied\");\n"
  + "}\n";
const CAPABILITIES = "export function checkCapability(user: string, action: string): boolean {\n"
  + "  return user.length > 0 && action.length > 0;\n"
  + "}\n";

describe("shotgun change evidence", () => {
  it("reports parallel edits sharing identifiers and a common dependency", () => {
    const changes = [
      change("src/handle-a.ts", HANDLER_A, [{ start: 3, end: 3 }]),
      change("src/handle-b.ts", HANDLER_B, [{ start: 3, end: 3 }]),
      change("src/capabilities.ts", CAPABILITIES, [{ start: 1, end: 3 }]),
    ];

    const evidence = buildShotgunChangeEvidence(candidate("src/handle-a.ts"), changes);

    expect(evidence).toMatchObject({
      anchorFile: "src/handle-a.ts",
      coverage: { totalFiles: 3, includedFiles: 3 },
      files: expect.arrayContaining([
        expect.objectContaining({ filePath: "src/handle-a.ts", changedLineCount: 1 }),
        expect.objectContaining({ filePath: "src/handle-b.ts", changedLineCount: 1 }),
      ]),      sharedIdentifiers: expect.arrayContaining([
        expect.objectContaining({
          identifier: "checkCapability",
          filePaths: ["src/capabilities.ts", "src/handle-a.ts", "src/handle-b.ts"],
        }),
      ]),
      sharedDependencies: [
        expect.objectContaining({
          source: "src/capabilities.ts",
          filePaths: ["src/handle-a.ts", "src/handle-b.ts"],
        }),
      ],
    });
  });

  it("abstains on a single-file change", () => {
    const changes = [change("src/handle-a.ts", HANDLER_A, [{ start: 3, end: 3 }])];

    expect(buildShotgunChangeEvidence(candidate("src/handle-a.ts"), changes)).toBeUndefined();
  });
});
