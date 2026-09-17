import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDomainPolicyInAdapterEvidence } from "../src/evidence/domain-policy-in-adapter.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function namedFunction(file: ProjectFile, name: string) {
  return extractCandidates(file.filePath, file.source)
    .find(({ kind, source }) => kind === "function" && source.includes(`function ${name}`));
}

describe("domain policy in adapter evidence", () => {
  it("shows Jev the adapter boundary, policy branch, and consumer", async () => {
    const projectFiles = await project("domain-policy-adapter-positive", [
      "src/gateways/stripe-payment-gateway.ts",
      "src/application/checkout.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = namedFunction(owner, "chargeCustomer");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildDomainPolicyInAdapterEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: {
        name: "chargeCustomer",
        exported: true,
        filePath: "src/gateways/stripe-payment-gateway.ts",
      },
      adapter: {
        pathSignal: "gateways",
        imports: [
          { source: "stripe", local: "Stripe", imported: "default" },
        ],
      },
      decisions: [
        {
          kind: "if",
          condition: "charge.customer.accountAgeDays < 30 && charge.amountCents > 50_000",
          outcome: expect.stringContaining("new-account-limit"),
        },
      ],
      callers: [
        expect.objectContaining({
          filePath: "src/application/checkout.ts",
          call: expect.stringContaining("chargeCustomer"),
        }),
      ],
      consumers: [
        expect.objectContaining({ source: expect.stringContaining("order.totalCents") }),
      ],
    });
  });

  it("keeps transport mappings eligible for semantic rejection", async () => {
    const projectFiles = await project("domain-policy-adapter-negative", [
      "src/http/place-order-route.ts",
      "src/application/place-order.ts",
      "src/http/routes.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = namedFunction(owner, "placeOrderRoute");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildDomainPolicyInAdapterEvidence(candidate, projectFiles)).toMatchObject({
      adapter: { pathSignal: "http" },
      decisions: [
        {
          kind: "switch",
          condition: "result.kind",
          outcome: expect.stringContaining("response.status(409)"),
        },
      ],
    });
  });

  it("abstains when branching has no adapter evidence", () => {
    const source = `export function approveRefund(refund: Refund) {
      if (refund.amountCents > 50000) return "review";
      return "approved";
    }`;
    const file = { filePath: "src/domain/approve-refund.ts", source };
    const candidate = namedFunction(file, "approveRefund");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildDomainPolicyInAdapterEvidence(candidate, [file])).toBeUndefined();
  });
});
