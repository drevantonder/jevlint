import { describe, expect, it } from "vitest";
import { buildUnownedFeatureFlagEvidence } from "../src/evidence/unowned-feature-flag.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

const before = `export function checkoutTotal(cart: Cart) {
  return renderLegacy(cart);
}
`;

const afterBare = `import { flags } from "./flags";
export function checkoutTotal(cart: Cart) {
  if (flags.newCheckout) {
    return renderNew(cart);
  }
  return renderLegacy(cart);
}
`;

const afterTicketed = `import { flags } from "./flags";
// owner: checkout-team, ticket: PROJ-123, removeAfter: 2026-12-01
export function checkoutTotal(cart: Cart) {
  if (flags.newCheckout) {
    return renderNew(cart);
  }
  return renderLegacy(cart);
}
`;

const siblingDisciplined: ProjectFile = {
  filePath: "src/search.ts",
  source: `import { flags } from "./flags";
// ticket: PROJ-99, owner: search-team
export function search(query: string) {
  if (flags.newSearch) {
    return searchV2(query);
  }
  return searchV1(query);
}
`,
};

function candidate(filePath: string): Candidate {
  return {
    id: "change_0",
    kind: "change",
    filePath,
    source: "Whole change. Use the rule-specific before/after evidence.",
    start: 0,
    end: 1,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  };
}

type ChangeScenario = {
  changes: SourceFile[];
  projectFiles: ProjectFile[];
};

function scenario(after: string): ChangeScenario {
  const changes: SourceFile[] = [{
    filePath: "src/checkout.ts",
    source: after,
    oldSource: before,
    changedLines: [{ start: 1, end: 7 }],
  }];
  const projectFiles: ProjectFile[] = [
    { filePath: "src/checkout.ts", source: after },
    siblingDisciplined,
  ];
  return { changes, projectFiles };
}

describe("unowned feature flag evidence", () => {
  it("extracts a newborn gate with no lifecycle beside disciplined siblings", () => {
    const { changes, projectFiles } = scenario(afterBare);
    const evidence = buildUnownedFeatureFlagEvidence(
      candidate("src/checkout.ts"),
      changes,
      projectFiles,
    );

    expect(evidence?.newGates.map(({ flagName }) => flagName)).toContain("newCheckout");
    expect(evidence?.newGates[0]).toMatchObject({
      lifecycle: { owner: null, ticket: null, expiry: null },
    });
    expect(evidence?.siblingFlagsWithLifecycle).toBeGreaterThan(0);
  });

  it("records owner, ticket, and expiry annotations on the new gate", () => {
    const { changes, projectFiles } = scenario(afterTicketed);
    const evidence = buildUnownedFeatureFlagEvidence(
      candidate("src/checkout.ts"),
      changes,
      projectFiles,
    );

    expect(evidence?.newGates[0]?.lifecycle.owner).not.toBeNull();
    expect(evidence?.newGates[0]?.lifecycle.ticket).not.toBeNull();
    expect(evidence?.newGates[0]?.lifecycle.expiry).not.toBeNull();
  });

  it("abstains when the repository keeps no flag discipline", () => {
    const changes: SourceFile[] = [{
      filePath: "src/checkout.ts",
      source: afterBare,
      oldSource: before,
      changedLines: [{ start: 1, end: 6 }],
    }];
    expect(buildUnownedFeatureFlagEvidence(
      candidate("src/checkout.ts"),
      changes,
      [{ filePath: "src/checkout.ts", source: afterBare }],
    )).toBeUndefined();
  });
});
