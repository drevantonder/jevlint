import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildSupersededApiUseEvidence } from "../src/evidence/superseded-api-use.js";
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

describe("superseded api use evidence", () => {
  it("flags a deprecated member while siblings use the successor", async () => {
    const projectFiles = await project("superseded-positive", [
      "src/encrypt.ts",
      "src/cipher.ts",
      "src/modern.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = candidateFor(owner, "createCipher(");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSupersededApiUseEvidence(candidate, projectFiles)).toMatchObject({
      uses: [
        {
          path: "crypto.createCipher",
          importedFrom: "./cipher.js",
          ownerFile: "src/cipher.ts",
          deprecated: true,
          successor: "createCipheriv",
          siblingSuccessorFiles: ["src/modern.ts"],
        },
      ],
    });
  });

  it("leaves successor calls unflagged", async () => {
    const projectFiles = await project("superseded-negative", [
      "src/encrypt.ts",
      "src/cipher.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = candidateFor(owner, "createCipheriv(");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildSupersededApiUseEvidence(candidate, projectFiles);
    expect(evidence).toBeDefined();
    expect(evidence?.uses.every((use) => !use.deprecated)).toBe(true);
  });

  it("abstains when the function touches no imported members", async () => {
    const owner: ProjectFile = {
      filePath: "src/plain.ts",
      source: "export function double(value: number): number {\n  return value * 2;\n}\n",
    };
    const candidate = candidateFor(owner, "double");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSupersededApiUseEvidence(candidate, [owner])).toBeUndefined();
  });
});
