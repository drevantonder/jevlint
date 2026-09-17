import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildAmbiguousPositionalSiblingsEvidence } from "../src/evidence/ambiguous-positional-siblings.js";
import type { ProjectFile } from "../src/types.js";

const SMELLY = `export function transfer(fromBalance: number, toBalance: number): number {
  return fromBalance - toBalance;
}
`;

const CALLER = `import { transfer } from "./ledger.js";

export function settle(checking: number, savings: number): number {
  return transfer(checking, savings);
}
`;

const DISTINCT = `export function greet(name: string, excited: boolean): string {
  return excited ? "hi " + name : "hello " + name;
}
`;

function candidate(source: string, filePath: string) {
  return extractCandidates(filePath, source).find(({ kind }) => kind === "function");
}

describe("ambiguous positional siblings evidence", () => {
  it("reports adjacent same-type parameters with positional call sites", () => {
    const files: ProjectFile[] = [
      { filePath: "src/ledger.ts", source: SMELLY },
      { filePath: "src/settle.ts", source: CALLER },
    ];
    const fn = candidate(SMELLY, "src/ledger.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    const evidence = buildAmbiguousPositionalSiblingsEvidence(fn, files);

    expect(evidence).toMatchObject({
      function: { name: "transfer", parameterCount: 2 },
      pairs: [
        expect.objectContaining({
          first: "fromBalance",
          second: "toBalance",
          sharedType: "number",
          explicitType: true,
        }),
      ],
      calls: [
        expect.objectContaining({
          firstArgument: "checking",
          secondArgument: "savings",
          sameKind: true,
        }),
      ],
    });
  });

  it("abstains when adjacent parameters have distinct types", () => {
    const files: ProjectFile[] = [{ filePath: "src/greet.ts", source: DISTINCT }];
    const fn = candidate(DISTINCT, "src/greet.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildAmbiguousPositionalSiblingsEvidence(fn, files)).toBeUndefined();
  });

  it("abstains without callers to establish order opacity", () => {
    const files: ProjectFile[] = [{ filePath: "src/ledger.ts", source: SMELLY }];
    const fn = candidate(SMELLY, "src/ledger.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildAmbiguousPositionalSiblingsEvidence(fn, files)).toBeUndefined();
  });
});
