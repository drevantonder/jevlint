import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildInvertedAuthorizationPredicateEvidence } from "../src/evidence/inverted-authorization-predicate.js";
import type { ProjectFile } from "../src/types.js";

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(
      new URL(`./fixtures/repositories/${name}/${filePath}`, import.meta.url),
      "utf8",
    ),
  })));
}

function candidateFor(files: ProjectFile[], filePath: string, marker: string) {
  const file = files.find((entry) => entry.filePath === filePath);
  expect(file).toBeDefined();
  if (!file) return undefined;
  const candidate = extractCandidates(file.filePath, file.source)
    .find(({ source }) => source.includes(marker));
  expect(candidate).toBeDefined();
  return candidate;
}

describe("inverted authorization predicate evidence", () => {
  it("shows Jev the conjunctive predicate next to its disjunctive sibling", async () => {
    const files = await project("inverted-authorization-predicate-positive", [
      "src/team.ts",
      "src/caller.ts",
    ]);
    const candidate = candidateFor(files, "src/team.ts", "canManageBilling");
    if (!candidate) return;

    const evidence = buildInvertedAuthorizationPredicateEvidence(candidate, files);

    expect(evidence).toMatchObject({
      function: {
        name: "canManageBilling",
        exported: true,
        source: expect.stringContaining("isTeamAdmin"),
      },
      predicates: [
        {
          kind: "conjunction",
          operator: "&&",
          expression: expect.stringContaining("isTeamOwner"),
        },
      ],
      siblingPredicates: [
        { operator: "||", sameFunction: false },
      ],
      callers: [{ filePath: "src/caller.ts" }],
    });
  });

  it("still reports the disjunctive predicate so Jev can clear it", async () => {
    const files = await project("inverted-authorization-predicate-negative", ["src/team.ts"]);
    const candidate = candidateFor(files, "src/team.ts", "canManageBilling");
    if (!candidate) return;

    const evidence = buildInvertedAuthorizationPredicateEvidence(candidate, files);

    expect(evidence).toMatchObject({
      predicates: [{ kind: "conjunction", operator: "||" }],
    });
  });

  it("abstains when the function holds no authorization shape", () => {
    const source = `export function total(prices: number[]) {
      return prices.reduce((sum, price) => sum + price, 0);
    }`;
    const candidate = extractCandidates("src/total.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildInvertedAuthorizationPredicateEvidence(
      candidate,
      [{ filePath: "src/total.ts", source }],
    )).toBeUndefined();
  });
});
