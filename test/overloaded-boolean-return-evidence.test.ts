import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildOverloadedBooleanReturnEvidence } from "../src/evidence/overloaded-boolean-return.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function load(repository: string, filePath: string): Promise<ProjectFile> {
  return {
    filePath,
    source: await readFile(new URL(`${repository}/${filePath}`, repositories), "utf8"),
  };
}

describe("overloaded boolean return evidence", () => {
  it("shows Jev the distinct return conditions and their call-site readings", async () => {
    const projectFiles = await Promise.all([
      load("overloaded-boolean-smelly", "src/access.ts"),
      load("overloaded-boolean-smelly", "src/callers.ts"),
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find((item) => item.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildOverloadedBooleanReturnEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "checkEntry" },
      booleanReturns: expect.arrayContaining([
        expect.objectContaining({ expression: expect.stringContaining("page !== null"), kind: "boolean-expression" }),
        expect.objectContaining({ expression: "false", kind: "literal" }),
        expect.objectContaining({ expression: "user.canDelete", kind: "property-read" }),
      ]),
      callers: expect.arrayContaining([
        expect.objectContaining({
          filePath: "src/callers.ts",
          branchReading: expect.stringContaining("when truthy"),
        }),
      ]),
    });
    expect(evidence?.callers.length).toBe(5);
  });

  it("abstains for a genuine single-property predicate", async () => {
    const owner = await load("overloaded-boolean-single", "src/access.ts");
    const projectFiles = [owner];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find((item) => item.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildOverloadedBooleanReturnEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when there are no callers to read the result", () => {
    const source = [
      "export function isEnabled(flag: string, other: string): boolean {",
      "  if (flag === 'on') return true;",
      "  if (other === 'on') return true;",
      "  return false;",
      "}",
    ].join("\n");
    const candidate = extractCandidates("src/flag.ts", source)
      .find((item) => item.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildOverloadedBooleanReturnEvidence(candidate, [{ filePath: "src/flag.ts", source }]))
      .toBeUndefined();
  });
});
