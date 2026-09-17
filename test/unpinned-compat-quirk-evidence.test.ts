import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnpinnedCompatQuirkEvidence } from "../src/evidence/unpinned-compat-quirk.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const LIB = "export function normalizeId(input: string): string {\n"
  + "  if (input === \"root\") return \"root\";\n"
  + "  return input.trim().toLowerCase();\n"
  + "}\n";
const APP = "import { normalizeId } from \"./lib.js\";\n"
  + "export function keyFor(input: string): string {\n"
  + "  return normalizeId(\"root\");\n"
  + "}\n";
const PLAIN_LIB = "export function slug(input: string): string {\n"
  + "  return input.trim().toLowerCase();\n"
  + "}\n";
const FALLBACK_LIB = "export function formatAll(inputs: string[], prefix: string): string[] {\n"
  + "  if (inputs.length === 0) return [];\n"
  + "  const head = inputs[0] as string;\n"
  + "  if (head === undefined) return [];\n"
  + "  return inputs.map((item) => `${prefix}${item.trim()}`);\n"
  + "}\n";
const FALLBACK_APP = "import { formatAll } from \"./lib.js\";\n"
  + "export function names(inputs: string[]): string[] {\n"
  + "  return formatAll(inputs, \"user:\");\n"
  + "}\n";

function candidateFor(files: ProjectFile[], filePath: string, marker: string): Candidate | undefined {
  const owner = files.find((file) => file.filePath === filePath);
  if (!owner) return undefined;
  return extractCandidates(owner.filePath, owner.source)
    .find(({ kind, source }) => kind === "function" && source.includes(marker));
}

describe("unpinned compat quirk evidence", () => {
  it("reports a special case exercised by a caller with no pinning", () => {
    const projectFiles: ProjectFile[] = [
      { filePath: "src/lib.ts", source: LIB },
      { filePath: "src/app.ts", source: APP },
    ];
    const candidate = candidateFor(projectFiles, "src/lib.ts", "normalizeId");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildUnpinnedCompatQuirkEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "normalizeId", exported: true, filePath: "src/lib.ts" },
      quirks: [
        {
          kind: "special-case",
          literal: "\"root\"",
          exercisedByCallers: [expect.stringContaining("normalizeId")],
        },
      ],
      callers: { total: 1, files: ["src/app.ts"] },
      pinning: { commentAbove: false, testReferences: [] },
    });
  });

  it("reports an unusual return beside a dominant convention", () => {
    const projectFiles: ProjectFile[] = [
      { filePath: "src/lib.ts", source: FALLBACK_LIB },
      { filePath: "src/app.ts", source: FALLBACK_APP },
    ];
    const candidate = candidateFor(projectFiles, "src/lib.ts", "formatAll");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildUnpinnedCompatQuirkEvidence(candidate, projectFiles);

    expect(evidence?.quirks.some(({ kind }) => kind === "unusual-return")).toBe(true);
    expect(evidence?.callers.total).toBe(1);
  });

  it("keeps pinning signals visible when a comment and test cover the quirk", () => {
    const commented = `// Keep the "root" passthrough: the access service depends on it.\n${LIB}`;
    const projectFiles: ProjectFile[] = [
      { filePath: "src/lib.ts", source: commented },
      { filePath: "src/app.ts", source: APP },
      {
        filePath: "test/lib.test.ts",
        source: "import { normalizeId } from \"../src/lib.js\";\n"
          + `test("root", () => expect(normalizeId("x")).toBe("x"));\n`,
      },
    ];
    const candidate = candidateFor(projectFiles, "src/lib.ts", "normalizeId");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildUnpinnedCompatQuirkEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      pinning: { commentAbove: true, testReferences: ["test/lib.test.ts"] },
    });
  });

  it("abstains when no in-repo caller can establish dependence", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/lib.ts", source: LIB }];
    const candidate = candidateFor(projectFiles, "src/lib.ts", "normalizeId");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnpinnedCompatQuirkEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when the function has no quirk span", () => {
    const projectFiles: ProjectFile[] = [
      { filePath: "src/lib.ts", source: PLAIN_LIB },
      {
        filePath: "src/app.ts",
        source: "import { slug } from \"./lib.js\";\nexport function key(s: string): string {\n  return slug(s);\n}\n",
      },
    ];
    const candidate = candidateFor(projectFiles, "src/lib.ts", "slug");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnpinnedCompatQuirkEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains for non-function candidates", () => {
    const projectFiles: ProjectFile[] = [
      { filePath: "src/lib.ts", source: LIB },
      { filePath: "src/app.ts", source: APP },
    ];
    const candidate = candidateFor(projectFiles, "src/lib.ts", "normalizeId");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnpinnedCompatQuirkEvidence({ ...candidate, kind: "comment" }, projectFiles))
      .toBeUndefined();
  });
});
