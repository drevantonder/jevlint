import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildSynonymVocabularyEvidence } from "../src/evidence/synonym-vocabulary.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/synonym-vocabulary-positive/", import.meta.url);
const negativeRoot = new URL("./fixtures/repositories/synonym-vocabulary-negative/", import.meta.url);

async function load(base: URL, filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, base), "utf8") };
}

describe("synonym vocabulary evidence", () => {
  it("clusters several verbs applied to one entity stem", async () => {
    const projectFiles = await Promise.all(["src/users.ts"].map((filePath) => load(root, filePath)));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildSynonymVocabularyEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      module: { filePath: "src/users.ts" },
      clusters: [
        {
          entity: "user",
          verbs: [
            expect.objectContaining({ verb: "fetch", name: "fetchUser" }),
            expect.objectContaining({ verb: "get", name: "getUser" }),
            expect.objectContaining({ verb: "load", name: "loadUser" }),
            expect.objectContaining({ verb: "retrieve", name: "retrieveUser" }),
          ],
        },
      ],
    });
  });

  it("abstains when no entity carries three verbs", async () => {
    const projectFiles = await Promise.all(["src/store.ts"].map((filePath) => load(negativeRoot, filePath)));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSynonymVocabularyEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains for non-abstraction candidates", () => {
    const source = "export function getUser(id: string): string { return id; }";
    const candidate = extractCandidates("src/users.ts", source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSynonymVocabularyEvidence(candidate, [
      { filePath: "src/users.ts", source },
    ])).toBeUndefined();
  });
});
