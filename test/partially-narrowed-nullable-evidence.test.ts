import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildPartiallyNarrowedNullableEvidence } from "../src/evidence/partially-narrowed-nullable.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function namedFunction(file: ProjectFile, name: string) {
  return extractCandidates(file.filePath, file.source)
    .find(({ kind, source }) => kind === "function" && source.includes(`function ${name}`));
}

describe("partially narrowed nullable evidence", () => {
  it("flags a union checked against null only before a dereferencing use", async () => {
    const projectFiles = await project("partially-narrowed-positive", [
      "src/member.ts",
      "src/card.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = namedFunction(owner, "displayName");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildPartiallyNarrowedNullableEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "displayName", exported: true, filePath: "src/member.ts" },
      partials: [
        {
          binding: "member",
          origin: "parameter",
          narrowed: ["null"],
          missing: ["undefined"],
          guards: [expect.stringContaining("member === null")],
          uses: [expect.stringContaining("member.profile")],
        },
      ],
    });
  });

  it("abstains when a loose equality narrows both absences", async () => {
    const projectFiles = await project("partially-narrowed-negative", ["src/member.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = namedFunction(owner, "displayName");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildPartiallyNarrowedNullableEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains on the unguarded-dereference shape without union annotations", async () => {
    const projectFiles = await project("unguarded-nullable-positive", [
      "src/member.ts",
      "src/users.ts",
      "src/route.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = namedFunction(owner, "memberDisplayName");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildPartiallyNarrowedNullableEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
