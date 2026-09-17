import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildNeedlessAbstractionEvidence } from "../src/evidence/needless-abstraction.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/needless-abstraction-smelly/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

describe("needless abstraction evidence", () => {
  it("finds the abstraction's implementations and consumers", async () => {
    const projectFiles = await Promise.all([
      "src/user-name-formatter.ts",
      "src/profile.ts",
    ].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildNeedlessAbstractionEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      abstraction: {
        name: "UserNameFormatter",
        kind: "interface",
        source: expect.stringContaining("format(user: User)"),
      },
      implementations: [
        expect.objectContaining({
          filePath: "src/user-name-formatter.ts",
          name: "DefaultUserNameFormatter",
          source: expect.stringContaining("implements UserNameFormatter"),
        }),
      ],
      consumers: [
        expect.objectContaining({
          filePath: "src/profile.ts",
          source: expect.stringContaining("new DefaultUserNameFormatter"),
        }),
      ],
    });
  });

  it("does not treat an unused declaration as enough evidence", () => {
    const source = "export interface Marker { value: string }";
    const candidate = extractCandidates("src/marker.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(buildNeedlessAbstractionEvidence(candidate, [{ filePath: "src/marker.ts", source }]))
      .toBeUndefined();
  });
});
