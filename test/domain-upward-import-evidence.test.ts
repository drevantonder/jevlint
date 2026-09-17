import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDomainUpwardImportEvidence } from "../src/evidence/domain-upward-import.js";
import type { ProjectFile } from "../src/types.js";

const pricing = `import { stripe } from "../adapters/stripe-client.js";
export function price(order: Order) {
  return stripe.quote(order);
}
`;

const kernelPricing = `import { Money } from "../shared/money.js";
export function price(order: Order) {
  return Money.zero();
}
`;

const stripeClient = `export const stripe = {
  quote(order: unknown) {
    return order;
  },
};
`;

const money = `export const Money = {
  zero() {
    return 0;
  },
};
`;

const caller = `import { price } from "../domain/pricing.js";
export function checkout(order: Order) {
  return price(order);
}
`;

function namedFunction(source: string, filePath: string, name: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(`function ${name}`));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("domain upward import evidence", () => {
  it("reports a domain function value-importing an adapter module", () => {
    const files: ProjectFile[] = [
      { filePath: "src/domain/pricing.ts", source: pricing },
      { filePath: "src/adapters/stripe-client.ts", source: stripeClient },
      { filePath: "src/application/checkout.ts", source: caller },
    ];
    const evidence = buildDomainUpwardImportEvidence(
      namedFunction(pricing, "src/domain/pricing.ts", "price"),
      files,
    );

    expect(evidence).toMatchObject({
      function: { name: "price", exported: true, layer: "domain" },
      upwardImports: [{
        source: "../adapters/stripe-client.js",
        resolved: "src/adapters/stripe-client.ts",
        layer: "adapter",
        valueImport: true,
      }],
    });
    expect(evidence?.upwardImports[0]?.importedSymbols).toContain("stripe");
    expect(evidence?.callers.map(({ filePath }) => filePath))
      .toContain("src/application/checkout.ts");
  });

  it("abstains when the domain function imports only shared kernel modules", () => {
    const files: ProjectFile[] = [
      { filePath: "src/domain/pricing.ts", source: kernelPricing },
      { filePath: "src/shared/money.ts", source: money },
    ];
    expect(buildDomainUpwardImportEvidence(
      namedFunction(kernelPricing, "src/domain/pricing.ts", "price"),
      files,
    )).toBeUndefined();
  });

  it("abstains for functions outside domain-owned paths", () => {
    const adapterFn = `import { stripe } from "./stripe-client.js";
export function quote(order: Order) {
  return stripe.quote(order);
}
`;
    const files: ProjectFile[] = [
      { filePath: "src/adapters/quoting.ts", source: adapterFn },
      { filePath: "src/adapters/stripe-client.ts", source: stripeClient },
    ];
    expect(buildDomainUpwardImportEvidence(
      namedFunction(adapterFn, "src/adapters/quoting.ts", "quote"),
      files,
    )).toBeUndefined();
  });
});
