import { describe, expect, it } from "vitest";
import { buildChangeStrandedCodeEvidence } from "../src/evidence/change-stranded-code.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

function candidate(filePath: string): Candidate {
  return {
    id: "change_0",
    kind: "change",
    filePath,
    source: "Whole change across 2 files.",
    start: 0,
    end: 24,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  };
}

const OLD_LIB = "export function formatUser(name: string): string {\n"
  + "  return name.trim();\n"
  + "}\n";
const NEW_LIB = "export function formatUser(name: string): string {\n"
  + "  return name.trim();\n"
  + "}\n"
  + "export function formatUserDisplay(name: string): string {\n"
  + "  return name.trim().toLowerCase();\n"
  + "}\n";
const OLD_APP = "import { formatUser } from \"./lib.js\";\n"
  + "export function label(name: string): string {\n"
  + "  return `User: ${formatUser(name)}`;\n"
  + "}\n";
const NEW_APP = "import { formatUserDisplay } from \"./lib.js\";\n"
  + "export function label(name: string): string {\n"
  + "  return `User: ${formatUserDisplay(name)}`;\n"
  + "}\n";

function strandingChanges(): SourceFile[] {
  return [
    {
      filePath: "src/lib.ts",
      source: NEW_LIB,
      oldSource: OLD_LIB,
      changedLines: [{ start: 4, end: 6 }],
    },
    {
      filePath: "src/app.ts",
      source: NEW_APP,
      oldSource: OLD_APP,
      changedLines: [{ start: 1, end: 3 }],
    },
  ];
}

describe("change stranded code evidence", () => {
  it("reports a retained function whose callers drop to zero beside a successor", () => {
    const changes = strandingChanges();
    const projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source }));

    const evidence = buildChangeStrandedCodeEvidence(candidate("src/lib.ts"), changes, projectFiles);

    expect(evidence).toMatchObject({
      anchorFile: "src/lib.ts",
      coverage: { totalFiles: 2, analyzedFiles: 2 },
      strandedFunctions: [
        {
          name: "formatUser",
          filePath: "src/lib.ts",
          exported: true,
          callersBefore: 1,
          callerExcerpts: [expect.stringContaining("src/app.ts")],
          successors: [
            {
              name: "formatUserDisplay",
              migratedCallSites: ["src/app.ts"],
            },
          ],
        },
      ],
    });
  });

  it("abstains when the old implementation leaves with the change", () => {
    const changes: SourceFile[] = [
      {
        filePath: "src/lib.ts",
        source: NEW_LIB.split("\n").slice(3).join("\n"),
        oldSource: OLD_LIB,
        changedLines: [{ start: 1, end: 3 }],
      },
      {
        filePath: "src/app.ts",
        source: NEW_APP,
        oldSource: OLD_APP,
        changedLines: [{ start: 1, end: 3 }],
      },
    ];
    const projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source }));

    expect(buildChangeStrandedCodeEvidence(candidate("src/lib.ts"), changes, projectFiles)).toBeUndefined();
  });

  it("abstains when the retained function keeps a caller", () => {
    const keptApp = `${OLD_APP
    }export function probe(name: string): string {\n  return formatUser(name);\n}\n`;
    const changes: SourceFile[] = [
      {
        filePath: "src/lib.ts",
        source: NEW_LIB,
        oldSource: OLD_LIB,
        changedLines: [{ start: 4, end: 6 }],
      },
      {
        filePath: "src/app.ts",
        source: keptApp,
        oldSource: OLD_APP,
        changedLines: [{ start: 4, end: 4 }],
      },
    ];
    const projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source }));

    expect(buildChangeStrandedCodeEvidence(candidate("src/lib.ts"), changes, projectFiles)).toBeUndefined();
  });

  it("abstains for non-change candidates and added-only changes", () => {
    const changes = strandingChanges();
    const projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source }));
    const functionCandidate: Candidate = { ...candidate("src/lib.ts"), kind: "function" };
    expect(buildChangeStrandedCodeEvidence(functionCandidate, changes, projectFiles)).toBeUndefined();

    const addedOnly: SourceFile[] = [
      { filePath: "src/new.ts", source: NEW_LIB, oldSource: null, changedLines: [{ start: 1, end: 6 }] },
    ];
    expect(buildChangeStrandedCodeEvidence(candidate("src/new.ts"), addedOnly)).toBeUndefined();
  });
});
