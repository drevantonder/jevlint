import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildTableConditionalEvidence } from "../src/evidence/table-shaped-conditional.js";
import type { ProjectFile } from "../src/types.js";

const feesSource = `export function feeForRegion(region: string): number {
  switch (region) {
    case "north":
      return 10;
    case "south":
      return 20;
    case "east":
      return 30;
    case "west":
      return 40;
    default:
      return 0;
  }
}
`;

const labelSource = `import { feeForRegion } from "./fees.js";

export function labelForRegion(region: string): string {
  if (region === "north") return "N";
  if (region === "south") return "S";
  if (region === "east") return "E";
  return feeForRegion(region) > 15 ? "far" : "near";
}
`;

const usageSource = `import { feeForRegion } from "./fees.js";

export function totalForRegions(regions: string[]): number {
  return regions.reduce((sum, region) => sum + feeForRegion(region), 0);
}
`;

const behaviorSource = `export function handleRegion(region: string): void {
  if (region === "north") {
    validateNorth();
  } else if (region === "south") {
    logSouth();
  } else if (region === "east") {
    retryEast();
  } else {
    throw new Error("unknown");
  }
}
`;

function candidate(source: string, filePath: string) {
  return extractCandidates(filePath, source).find(({ kind }) => kind === "function");
}

describe("table shaped conditional evidence", () => {
  it("extracts a data-only switch with cross-file mappers and callers", () => {
    const files: ProjectFile[] = [
      { filePath: "src/fees.ts", source: feesSource },
      { filePath: "src/label.ts", source: labelSource },
      { filePath: "src/usage.ts", source: usageSource },
    ];
    const fn = candidate(feesSource, "src/fees.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    const evidence = buildTableConditionalEvidence(fn, files);

    expect(evidence).toMatchObject({
      function: { name: "feeForRegion", filePath: "src/fees.ts" },
      mapping: {
        baseExpression: "region",
        arms: [
          expect.objectContaining({ kind: "switch-case", test: '"north"' }),
          expect.objectContaining({ kind: "switch-case", test: '"south"' }),
          expect.objectContaining({ kind: "switch-case", test: '"east"' }),
          expect.objectContaining({ kind: "switch-case", test: '"west"' }),
        ],
      },
      otherMappers: [expect.objectContaining({
        filePath: "src/label.ts",
        functionName: "labelForRegion",
      })],
      callers: expect.arrayContaining([expect.objectContaining({
        filePath: "src/usage.ts",
        call: expect.stringContaining("feeForRegion("),
      })]),
    });
  });

  it("abstains when an arm performs behavior", () => {
    const fn = candidate(behaviorSource, "src/handle.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildTableConditionalEvidence(fn, [{ filePath: "src/handle.ts", source: behaviorSource }])).toBeUndefined();
  });

  it("abstains for a single transient branch", () => {
    const source = `export function label(mode: string): string {
      if (mode === "fast") return "F";
      return "S";
    }
    `;
    const fn = candidate(source, "src/label.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildTableConditionalEvidence(fn, [{ filePath: "src/label.ts", source }])).toBeUndefined();
  });
});
