import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildPhantomPackageImportEvidence } from "../src/evidence/phantom-package-import.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function candidateFor(owner: ProjectFile, needle: string) {
  return extractCandidates(owner.filePath, owner.source)
    .filter(({ kind, source }) => kind === "function" && source.includes(needle))
    .sort((left, right) => left.source.length - right.source.length)[0];
}

describe("phantom package import evidence", () => {
  it("flags an import absent from every manifest and lockfile", async () => {
    const projectFiles = await project("phantom-positive", [
      "src/main.ts",
      "package.json",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = candidateFor(owner, "convertTimestamp");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildPhantomPackageImportEvidence(candidate, projectFiles)).toMatchObject({
      imports: [
        {
          source: "date-fns-tz-extended",
          kind: "undeclared",
          declaredIn: null,
          lockfileHit: false,
        },
      ],
      manifest: { filePath: "package.json" },
      lockfilesChecked: [],
    });
  });

  it("passes declared, locked, builtin, and relative imports", async () => {
    const projectFiles = await project("phantom-negative", [
      "src/main.ts",
      "src/util.ts",
      "package.json",
      "package-lock.json",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = candidateFor(owner, "renderStamp");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildPhantomPackageImportEvidence(candidate, projectFiles)).toMatchObject({
      imports: expect.arrayContaining([
        { source: "date-fns", kind: "declared", declaredIn: "dependencies", lockfileHit: true, aliasMapped: false },
        expect.objectContaining({ source: "node:path", kind: "builtin" }),
        expect.objectContaining({ source: "./util.js", kind: "relative" }),
      ]),
    });
  });

  it("abstains when the function imports nothing", async () => {
    const owner: ProjectFile = {
      filePath: "src/plain.ts",
      source: "export function double(value: number): number {\n  return value * 2;\n}\n",
    };
    const candidate = candidateFor(owner, "double");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildPhantomPackageImportEvidence(candidate, [owner])).toBeUndefined();
  });
});
