import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildRepeatedPredicateEvidence } from "../src/evidence/repeated-predicate.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function load(repository: string, filePath: string): Promise<ProjectFile> {
  return {
    filePath,
    source: await readFile(new URL(`${repository}/${filePath}`, repositories), "utf8"),
  };
}

describe("repeated predicate evidence", () => {
  it("shows Jev the unbound predicate tested four times", async () => {
    const owner = await load("repeated-predicate-smelly", "src/policy.ts");
    const projectFiles = [owner];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find((item) => item.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildRepeatedPredicateEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "describeAccess" },
      repetitions: [
        expect.objectContaining({
          predicate: expect.stringContaining('user.role === "admin"'),
          boundToName: null,
          interveningAwait: false,
        }),
      ],
    });
    expect(evidence?.repetitions[0]?.occurrences.length).toBeGreaterThanOrEqual(3);
  });

  it("abstains when the outcome is named and reused", async () => {
    const owner = await load("repeated-predicate-named", "src/policy.ts");
    const projectFiles = [owner];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find((item) => item.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildRepeatedPredicateEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when no predicate repeats", () => {
    const source = "export function isEmpty(items: string[]) { return items.length === 0; }";
    const candidate = extractCandidates("src/empty.ts", source)
      .find((item) => item.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildRepeatedPredicateEvidence(candidate, [{ filePath: "src/empty.ts", source }]))
      .toBeUndefined();
  });
});
