import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildImplementationTypeInSignatureEvidence } from "../src/evidence/implementation-type-in-signature.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/implementation-type-in-signature-smelly/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

const clean = `export interface User {
  id: string;
  displayName: string;
}
export async function getUser(id: string): Promise<User | undefined> {
  return lookup(id);
}
declare function lookup(id: string): Promise<User | undefined>;
`;

describe("implementation type in signature evidence", () => {
  it("names the library type exposed by an exported parameter", async () => {
    const projectFiles = await Promise.all(["src/service.ts", "src/app.ts"].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind, source }) => kind === "function" && source.includes("getUser"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildImplementationTypeInSignatureEvidence(candidate, projectFiles);

    expect(evidence?.function).toMatchObject({ name: "getUser", exported: true });
    expect(evidence?.exposedTypes).toContainEqual(
      expect.objectContaining({
        name: "DbClient",
        position: "parameter",
        origin: "external-package",
        importedFrom: "db-driver",
        targetLooksInfrastructural: true,
      }),
    );
    expect(evidence?.domainAlternativeNearby).toContain("User");
    expect(evidence?.callers.map(({ filePath }) => filePath)).toContain("src/app.ts");
  });

  it("abstains when the signature uses only local domain types", () => {
    const candidate = extractCandidates("src/service.ts", clean)
      .find(({ kind, source }) => kind === "function" && source.includes("getUser"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildImplementationTypeInSignatureEvidence(
      candidate,
      [{ filePath: "src/service.ts", source: clean }],
    )).toBeUndefined();
  });

  it("dispatches through the rule registry", async () => {
    const projectFiles = await Promise.all(["src/service.ts", "src/app.ts"].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind, source }) => kind === "function" && source.includes("getUser"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const result = buildRuleEvidence(
      "jev/no-implementation-type-in-signature",
      candidate,
      projectFiles,
    );

    expect(result.handled).toBe(true);
    expect(result.handled && result.evidence).toBeDefined();
  });
});
