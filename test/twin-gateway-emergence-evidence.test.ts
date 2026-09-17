import { describe, expect, it } from "vitest";
import { buildTwinGatewayEmergenceEvidence } from "../src/evidence/twin-gateway-emergence.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

function projectFile(filePath: string, source = "export const value = 1;\n"): ProjectFile {
  return { filePath, source };
}

function moduleCandidate(filePath: string): Candidate {
  return {
    id: "module_0",
    kind: "module",
    filePath,
    source: "",
    start: 0,
    end: 0,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  };
}

const gateway = `import Stripe from "stripe";
export class Charge {
  constructor(readonly id: string) {}
}
const stripe = new Stripe("key");
export async function createCharge(amount: number) {
  const intent = await stripe.paymentIntents.create({ amount });
  return new Charge(intent.id);
}
`;

const checkout = `import { createCharge } from "./stripe-gateway.js";
export async function checkout(amount: number) {
  return createCharge(amount);
}
`;

const refund = `import { Charge } from "./stripe-gateway.js";
export function refund(charge: Charge) {
  return charge.id;
}
`;

const rates = `import { createCharge } from "../billing/stripe-gateway.js";
export async function estimate(amount: number) {
  return createCharge(amount);
}
`;

const labelsBefore = `export function label(orderId: string) {
  return orderId;
}
`;

const labelsAfter = `import Stripe from "stripe";
const stripe = new Stripe("key");
export async function label(orderId: string) {
  const intent = await stripe.paymentIntents.create({ amount: 100 });
  return intent.id + orderId;
}
`;

function repo(labelsSource: string, labelsOld: string | null, includeGateway = true) {
  const files = [
    ...(includeGateway
      ? [
        projectFile("billing/stripe-gateway.ts", gateway),
        projectFile("billing/checkout.ts", checkout),
        projectFile("billing/refund.ts", refund),
      ]
      : []),
    projectFile("shipping/rates.ts", rates),
    projectFile("shipping/labels.ts", labelsSource),
    ...Array.from({ length: 8 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
  ];
  const changes: SourceFile[] = [{
    filePath: "shipping/labels.ts",
    source: labelsSource,
    oldSource: labelsOld,
    changedLines: [{ start: 1, end: 1 }],
  }];
  return { files, changes };
}

describe("twin gateway emergence evidence", () => {
  it("captures a new direct wrap beside an established gateway", () => {
    const { files, changes } = repo(labelsAfter, labelsBefore);

    const evidence = buildTwinGatewayEmergenceEvidence(
      moduleCandidate("shipping/labels.ts"),
      files,
      changes,
    );

    expect(evidence?.dependency).toBe("stripe");
    expect(evidence?.specifier).toBe("stripe");
    expect(evidence?.declared).toBe(false);
    expect(evidence?.gateways).toHaveLength(1);
    expect(evidence?.gateways[0]).toMatchObject({
      path: "billing/stripe-gateway.ts",
      area: "billing",
      importerCount: 3,
    });
    expect(evidence?.gateways[0]?.domainExports).toContain("Charge");
    expect(evidence?.reuseOneEdgeAway).toBe(true);
    expect(evidence?.usedSymbols).toEqual(["default"]);
  });

  it("is reachable through the shared evidence dispatch", () => {
    const { files, changes } = repo(labelsAfter, labelsBefore);

    const result = buildRuleEvidence(
      "jev/no-twin-gateway-emergence",
      moduleCandidate("shipping/labels.ts"),
      files,
      changes,
    );

    expect(result.handled).toBe(true);
    if (result.handled) expect(result.evidence).toBeDefined();
  });

  it("abstains for non-module candidates", () => {
    const { files, changes } = repo(labelsAfter, labelsBefore);

    expect(
      buildTwinGatewayEmergenceEvidence(
        { ...moduleCandidate("shipping/labels.ts"), id: "change_0", kind: "change" },
        files,
        changes,
      ),
    ).toBeUndefined();
  });

  it("abstains when no other-area gateway exists yet", () => {
    const { files, changes } = repo(labelsAfter, labelsBefore, false);

    expect(
      buildTwinGatewayEmergenceEvidence(moduleCandidate("shipping/labels.ts"), files, changes),
    ).toBeUndefined();
  });

  it("abstains when the external edge is not new", () => {
    const { files, changes } = repo(labelsAfter, labelsAfter);

    expect(
      buildTwinGatewayEmergenceEvidence(moduleCandidate("shipping/labels.ts"), files, changes),
    ).toBeUndefined();
  });
});
