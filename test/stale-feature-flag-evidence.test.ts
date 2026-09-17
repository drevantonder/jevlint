import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildStaleFeatureFlagEvidence } from "../src/evidence/stale-feature-flag.js";
import type { ProjectFile } from "../src/types.js";

const fossilized = `import { flags } from "./flags";
export function checkoutTotal(cart: Cart) {
  if (flags.newCheckout) {
    return renderNew(cart);
  }
  return renderLegacy(cart);
}
`;

const flagsModule: ProjectFile = {
  filePath: "src/flags.ts",
  source: `export const flags = { newCheckout: true };
`,
};

const deadArm = `import { flags } from "./config";
export function checkoutTotal(cart: Cart) {
  if (flags.newCheckout) {
    return renderNew(cart);
  } else {
  }
  return renderNew(cart);
}
`;

const liveFlag = `export function checkoutTotal(cart: Cart) {
  if (process.env.NEW_CHECKOUT === "1") {
    return renderNew(cart);
  }
  return renderLegacy(cart);
}
`;

const noFlag = `export function checkoutTotal(cart: Cart, coupon: string) {
  if (coupon === "SAVE") {
    return discount(cart);
  }
  return fullPrice(cart);
}
`;

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("stale feature flag evidence", () => {
  it("traces a flag bound to a constant at its source", () => {
    const filePath = "src/checkout.ts";
    const files = [{ filePath, source: fossilized }, flagsModule];
    const evidence = buildStaleFeatureFlagEvidence(candidateFor(fossilized, filePath, "checkoutTotal"), files);

    expect(evidence).toMatchObject({
      function: { name: "checkoutTotal", exported: true },
      flagChecks: [{ kind: "if", consequent: "live", alternate: "missing" }],
      flagSourceHint: "constant",
    });
    expect(evidence?.flagChecks[0]?.expression).toContain("newCheckout");
    expect(evidence?.flagSourceDetail).toContain("src/flags.ts");
  });

  it("marks the empty arm of a fossilized branch", () => {
    const filePath = "src/checkout.ts";
    const files: ProjectFile[] = [
      { filePath, source: deadArm },
      { filePath: "src/config.ts", source: `export const flags = { newCheckout: true };\n` },
    ];
    const evidence = buildStaleFeatureFlagEvidence(candidateFor(deadArm, filePath, "checkoutTotal"), files);

    expect(evidence?.flagChecks).toMatchObject([{ alternate: "empty" }]);
  });

  it("keeps a live environment flag visible with an env hint", () => {
    const filePath = "src/checkout.ts";
    const files = [{ filePath, source: liveFlag }];
    const evidence = buildStaleFeatureFlagEvidence(candidateFor(liveFlag, filePath, "checkoutTotal"), files);

    expect(evidence?.flagChecks).toHaveLength(1);
    expect(evidence?.flagSourceHint).toBe("env");
  });

  it("abstains when no flag-shaped check exists", () => {
    const filePath = "src/checkout.ts";
    const files = [{ filePath, source: noFlag }];
    expect(buildStaleFeatureFlagEvidence(candidateFor(noFlag, filePath, "checkoutTotal"), files))
      .toBeUndefined();
  });

  it("includes callers forcing one side", () => {
    const filePath = "src/checkout.ts";
    const files: ProjectFile[] = [
      { filePath, source: fossilized },
      flagsModule,
      {
        filePath: "src/route.ts",
        source: `import { checkoutTotal } from "./checkout";\nexport function post(c: never) { return checkoutTotal(c); }`,
      },
    ];
    const evidence = buildStaleFeatureFlagEvidence(candidateFor(fossilized, filePath, "checkoutTotal"), files);
    expect(evidence?.callers).toMatchObject([{ filePath: "src/route.ts" }]);
  });
});
