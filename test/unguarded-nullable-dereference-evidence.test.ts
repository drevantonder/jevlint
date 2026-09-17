import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnguardedNullableDereferenceEvidence } from "../src/evidence/unguarded-nullable-dereference.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("unguarded nullable dereference evidence", () => {
  it("extracts the nullable origin, unguarded use, and callers", async () => {
    const projectFiles = await project("unguarded-nullable-positive", [
      "src/member.ts",
      "src/users.ts",
      "src/route.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function memberDisplayName"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildUnguardedNullableDereferenceEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "memberDisplayName", exported: true },
      dereferences: [expect.objectContaining({
        binding: "member",
        origin: expect.stringContaining("find"),
        guarded: false,
      })],
      repository: {
        callers: [expect.objectContaining({ filePath: "src/route.ts" })],
        relatedModules: [expect.objectContaining({ filePath: "src/users.ts" })],
      },
    });
  });

  it("abstains when a throw guard covers the nullable source", async () => {
    const projectFiles = await project("unguarded-nullable-negative", [
      "src/member.ts",
      "src/users.ts",
      "src/route.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function memberDisplayName"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnguardedNullableDereferenceEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when the value has no nullable origin", () => {
    const source = `
      export function greet(user: { name: string }): string {
        return user.name;
      }
    `;
    const candidate = extractCandidates("src/greet.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUnguardedNullableDereferenceEvidence(
      candidate,
      [{ filePath: "src/greet.ts", source }],
    )).toBeUndefined();
  });
});
