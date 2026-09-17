import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDoubledPureHelperEvidence } from "../src/evidence/doubled-pure-helper.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function testCandidate(owner: ProjectFile, marker: string) {
  const candidate = extractCandidates(owner.filePath, owner.source)
    .filter(({ kind, source }) => kind === "function" && source.includes(marker))
    .sort((left, right) => left.source.length - right.source.length)[0];
  expect(candidate).toBeDefined();
  return candidate;
}

describe("doubled pure helper evidence", () => {
  it("reports a mocked pure helper beside the real subject call", async () => {
    const projectFiles = await project("doubled-helper", [
      "test/slug.test.ts",
      "src/slug.ts",
      "src/cart.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "cardPath(");
    if (!candidate) return;

    const evidence = buildDoubledPureHelperEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      test: { title: "builds a path from the title", filePath: "test/slug.test.ts" },
      doubles: [
        {
          helper: "slugify",
          helperFile: "src/slug.ts",
          analyzable: true,
          pure: true,
          impuritySignals: [],
          helperSource: expect.stringContaining("replaceAll"),
          cannedValues: [expect.stringContaining("mockReturnValue")],
        },
      ],
      otherProjectCalls: ["cardPath"],
    });
  });

  it("marks a clock-dependent helper as impure", async () => {
    const projectFiles: ProjectFile[] = [
      {
        filePath: "src/stamp.ts",
        source: "export function stamp(): number {\n  return Date.now();\n}\n",
      },
      {
        filePath: "test/stamp.test.ts",
        source: "import { describe, expect, it, vi } from \"vitest\";\n"
          + "import { stamp } from \"../src/stamp.js\";\n"
          + "vi.mock(\"../src/stamp.js\", () => ({ stamp: vi.fn(() => 7) }));\n"
          + "describe(\"stamp\", () => {\n"
          + "  it(\"pins the clock\", () => {\n"
          + "    vi.mocked(stamp).mockReturnValue(7);\n"
          + "    expect(stamp()).toBe(7);\n"
          + "  });\n"
          + "});\n",
      },
    ];
    const candidate = testCandidate(projectFiles[1]!, "toBe(7)");
    if (!candidate) return;

    const evidence = buildDoubledPureHelperEvidence(candidate, projectFiles);

    expect(evidence?.doubles[0]).toMatchObject({
      helper: "stamp",
      analyzable: true,
      pure: false,
      impuritySignals: [expect.stringContaining("nondeterminism")],
    });
  });

  it("abstains when the test uses no module mocks", async () => {
    const projectFiles: ProjectFile[] = [
      {
        filePath: "src/slug.ts",
        source: "export function slugify(title: string): string {\n  return title.trim();\n}\n",
      },
      {
        filePath: "test/slug.test.ts",
        source: "import { describe, expect, it } from \"vitest\";\n"
          + "import { slugify } from \"../src/slug.js\";\n"
          + "describe(\"slug\", () => {\n"
          + "  it(\"trims\", () => {\n"
          + "    expect(slugify(\" hi \")).toBe(\"hi\");\n"
          + "  });\n"
          + "});\n",
      },
    ];
    const candidate = testCandidate(projectFiles[1]!, "trims");
    if (!candidate) return;

    expect(buildDoubledPureHelperEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
