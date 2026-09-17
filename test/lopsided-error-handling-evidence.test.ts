import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildLopsidedErrorHandlingEvidence } from "../src/evidence/lopsided-error-handling.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function load(repository: string, filePath: string): Promise<ProjectFile> {
  return {
    filePath,
    source: await readFile(new URL(`${repository}/${filePath}`, repositories), "utf8"),
  };
}

describe("lopsided error handling evidence", () => {
  it("shows Jev the guarded and bare siblings of the same kind", async () => {
    const owner = await load("lopsided-error-smelly", "src/orders.ts");
    const projectFiles = [owner];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find((item) => item.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildLopsidedErrorHandlingEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "fulfillOrder" },
      groups: [
        expect.objectContaining({
          kind: "await:db",
          guarded: expect.arrayContaining([
            expect.objectContaining({ call: expect.stringContaining("fetchOrder") }),
            expect.objectContaining({ call: expect.stringContaining("charge") }),
          ]),
          unguarded: [expect.objectContaining({ call: expect.stringContaining("ship") })],
        }),
      ],
      outerHandlerCoversBody: false,
    });
  });

  it("abstains when one outer handler covers the whole body", async () => {
    const owner = await load("lopsided-error-uniform", "src/orders.ts");
    const projectFiles = [owner];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find((item) => item.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildLopsidedErrorHandlingEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when there are no fallible operations to compare", () => {
    const source = "export function total(items: number[]) { return items.reduce((a, b) => a + b, 0); }";
    const candidate = extractCandidates("src/total.ts", source)
      .find((item) => item.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildLopsidedErrorHandlingEvidence(candidate, [{ filePath: "src/total.ts", source }]))
      .toBeUndefined();
  });
});
