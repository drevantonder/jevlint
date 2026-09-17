import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildTypeCheckerEscapeEvidence } from "../src/evidence/type-checker-escape.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("type checker escape evidence", () => {
  it("flags an unguarded assertion over a runtime boundary value", async () => {
    const projectFiles = await project("type-checker-escape-positive", ["src/invoice.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function loadInvoice"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildTypeCheckerEscapeEvidence(candidate, projectFiles)).toMatchObject({
      function: { name: "loadInvoice", exported: true },
      escapes: [{
        kind: "as-cast",
        assertedType: "Invoice",
        castsThroughAny: false,
        sourceKind: "runtime-boundary",
        narrowingGuardNearby: false,
      }],
      hasValidatorImport: false,
    });
  });

  it("records the narrowing guard next to a caller-supplied assertion", async () => {
    const projectFiles = await project("type-checker-escape-exception", ["src/invoice.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function parseCount"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildTypeCheckerEscapeEvidence(candidate, projectFiles)).toMatchObject({
      escapes: [{
        kind: "as-cast",
        assertedType: "number",
        sourceKind: "caller-supplied",
        narrowingGuardNearby: true,
      }],
    });
  });

  it("abstains when the function contains no escape", async () => {
    const projectFiles = await project("type-checker-escape-negative", ["src/invoice.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function invoiceTotal"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildTypeCheckerEscapeEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("flags non-null assertions and records bare any annotations as notes", () => {
    const source = `
      export function firstUser(users: any[]): any {
        return users[0]!;
      }
    `;
    const candidate = extractCandidates("src/users.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildTypeCheckerEscapeEvidence(
      candidate,
      [{ filePath: "src/users.ts", source }],
    )).toMatchObject({
      escapes: [{ kind: "non-null" }],
      bareAnyAnnotations: expect.arrayContaining([expect.stringContaining("any")]),
    });
  });
});
