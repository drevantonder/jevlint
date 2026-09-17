import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildPrototypeInProductionEvidence } from "../src/evidence/prototype-in-production.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `import { charge } from "./payments";

export function checkout(cart: Cart) {
  // Temporary workaround for launch: hardcoded region routing.
  if (true) {
    return charge(cart, "us-east-1");
  }
  return charge(cart, cart.region);
}
`;

const flaggedOnly = `// Experimental: new recommendation ranking behind the flag.
export function rankExperimental(items: string[]) {
  if (!flags.recommendationsV2) return items;
  return items.toSorted();
}
`;

const clean = `export function checkout(cart: Cart) {
  return charge(cart, cart.region);
}
`;

function candidateFor(filePath: string, source: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("prototype in production evidence", () => {
  it("pairs maturity markers with production callers and provisional flow", () => {
    const files: ProjectFile[] = [
      { filePath: "src/checkout.ts", source: smelly },
      { filePath: "src/payments.ts", source: "export function charge(c: Cart, r: string) {}" },
      {
        filePath: "src/handler.ts",
        source: `import { checkout } from "./checkout";\nexport function handle(cart: Cart) { return checkout(cart); }`,
      },
    ];
    const evidence = buildPrototypeInProductionEvidence(
      candidateFor("src/checkout.ts", smelly, "Temporary workaround"),
      files,
    );

    expect(evidence).toMatchObject({
      function: { name: "checkout", exported: true },
      markers: [expect.objectContaining({ excerpt: expect.stringContaining("Temporary workaround") })],
      provisional: { literalConditions: ["true"] },
      repository: {
        callers: [{ filePath: "src/handler.ts", call: "checkout(cart)" }],
      },
    });
  });

  it("still reports flagged-only use so Jev can score it low", () => {
    const files: ProjectFile[] = [{ filePath: "src/rank.ts", source: flaggedOnly }];
    const evidence = buildPrototypeInProductionEvidence(
      candidateFor("src/rank.ts", flaggedOnly, "Experimental"),
      files,
    );
    expect(evidence?.markers).toHaveLength(1);
    expect(evidence?.repository.callers).toEqual([]);
  });

  it("lists sibling functions as hardened-alternative candidates", () => {
    const source = `${smelly}\nexport function checkoutStable(cart: Cart) {\n  return charge(cart, cart.region);\n}`;
    const files: ProjectFile[] = [{ filePath: "src/checkout.ts", source }];
    const evidence = buildPrototypeInProductionEvidence(
      candidateFor("src/checkout.ts", source, "Temporary workaround"),
      files,
    );
    expect(evidence?.repository.siblings).toMatchObject([{ name: "checkoutStable", exported: true }]);
  });

  it("abstains when no maturity marker is present", () => {
    const files: ProjectFile[] = [{ filePath: "src/checkout.ts", source: clean }];
    expect(buildPrototypeInProductionEvidence(
      candidateFor("src/checkout.ts", clean, "charge(cart, cart.region)"),
      files,
    )).toBeUndefined();
  });
});
