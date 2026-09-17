import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildUnpinnedBoundaryBranchEvidence } from "../src/evidence/unpinned-boundary-branch.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const positive = `export function discountFor(tier: string, amount: number) {
  if (tier === "gold" && amount > 1000) {
    return amount * 0.85;
  }
  return amount;
}
`;

const caller = `import { discountFor } from "./discount";
export function checkout(tier: string, amount: number) {
  return discountFor(tier, amount);
}
`;

const pinnedTest = `import { discountFor } from "./discount";
import { describe, expect, it } from "vitest";
describe("discountFor", () => {
  it("discounts gold above the boundary", () => {
    expect(discountFor("gold", 1001)).toBe(850.85);
    expect(discountFor("gold", 1000)).toBe(1000);
  });
});
`;

const plain = `export function add(a: number, b: number) {
  return a + b;
}
`;

function candidateFor(source: string, filePath: string, snippet: string): Candidate {
  const found = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(snippet));
  expect(found).toBeDefined();
  expect(found?.kind).toBe("function");
  if (!found) throw new Error("candidate missing");
  return found;
}

describe("unpinned boundary branch evidence", () => {
  it("extracts boundary predicates with caller reachability", () => {
    const projectFiles: ProjectFile[] = [
      { filePath: "src/discount.ts", source: positive },
      { filePath: "src/checkout.ts", source: caller },
    ];
    const candidate = candidateFor(positive, "src/discount.ts", "function discountFor");

    const evidence = buildUnpinnedBoundaryBranchEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "discountFor", exported: true },
      branches: [
        { kind: "equality-tier", predicate: expect.stringContaining("gold") },
      ],
      pinning: {
        callers: [expect.objectContaining({ filePath: "src/checkout.ts" })],
        testReferences: [],
      },
    });
  });

  it("surfaces test pinning so the judgment can score low", () => {
    const projectFiles: ProjectFile[] = [
      { filePath: "src/discount.ts", source: positive },
      { filePath: "src/discount.test.ts", source: pinnedTest },
    ];
    const candidate = candidateFor(positive, "src/discount.ts", "function discountFor");

    const evidence = buildUnpinnedBoundaryBranchEvidence(candidate, projectFiles);

    expect(evidence?.pinning.testReferences).toEqual(["src/discount.test.ts"]);
  });

  it("abstains when the function has no boundary branch", () => {
    const candidate = candidateFor(plain, "src/add.ts", "function add");

    expect(buildUnpinnedBoundaryBranchEvidence(candidate, [{ filePath: "src/add.ts", source: plain }]))
      .toBeUndefined();
  });

  it("abstains for non-function candidates", () => {
    const comment = { ...candidateFor(positive, "src/discount.ts", "function discountFor"), kind: "comment" as const };
    expect(buildUnpinnedBoundaryBranchEvidence(comment, [{ filePath: "src/discount.ts", source: positive }]))
      .toBeUndefined();
  });

  it("dispatches through the rule registry", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/discount.ts", source: positive }];
    const candidate = candidateFor(positive, "src/discount.ts", "function discountFor");

    const result = buildRuleEvidence("jev/no-unpinned-boundary-branch", candidate, projectFiles);

    expect(result.handled).toBe(true);
    expect(result.handled && result.evidence).toBeDefined();
  });
});
