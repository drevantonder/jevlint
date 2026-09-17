import { describe, expect, it } from "vitest";
import { buildSharedKernelNewConsumerEvidence } from "../src/evidence/shared-kernel-new-consumer.js";
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

function nonModuleCandidate(filePath: string): Candidate {
  return { ...moduleCandidate(filePath), id: "change_0", kind: "change" };
}

const kernel = `export class Order {
  constructor(readonly id: string) {}
}
export class Customer {
  constructor(readonly name: string) {}
}
export function orderTotal(order: Order) {
  return 0;
}
`;

const billingConsumer = `import { Order } from "../shared/kernel.js";
export function bill(order: Order) {
  return order.id;
}
`;

const shippingConsumer = `import { Customer } from "../shared/kernel.js";
export function shipTo(customer: Customer) {
  return customer.name;
}
`;

const ordersConsumer = `import { orderTotal } from "../shared/kernel.js";
export function tally(ids: string[]) {
  return ids.length + orderTotal.length;
}
`;

const payBefore = `export function pay(amount: number) {
  return amount;
}
`;

const payAfter = `import { Order } from "../shared/kernel.js";
export function pay(order: Order) {
  return order.id;
}
`;

function repo(paySource: string, payOld: string | null) {
  const files = [
    projectFile("shared/kernel.ts", kernel),
    projectFile("billing/invoice.ts", billingConsumer),
    projectFile("shipping/label.ts", shippingConsumer),
    projectFile("orders/history.ts", ordersConsumer),
    projectFile("invoicing/pay.ts", paySource),
    ...Array.from({ length: 6 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
  ];
  const changes: SourceFile[] = [{
    filePath: "invoicing/pay.ts",
    source: paySource,
    oldSource: payOld,
    changedLines: [{ start: 1, end: 1 }],
  }];
  return { files, changes };
}

describe("shared kernel new consumer evidence", () => {
  it("captures a new edge from a fresh area into an entrenched kernel", () => {
    const { files, changes } = repo(payAfter, payBefore);

    const evidence = buildSharedKernelNewConsumerEvidence(
      moduleCandidate("invoicing/pay.ts"),
      files,
      changes,
    );

    expect(evidence?.target).toBe("shared/kernel.ts");
    expect(evidence?.specifier).toBe("../shared/kernel.js");
    expect(evidence?.kernelMarkers.sharedSegment).toBe(true);
    expect(evidence?.kernelMarkers.domainExports).toContain("Order");
    expect(evidence?.kernelMarkers.genericTarget).toBe(false);
    expect(evidence?.entrenchment.importerCount).toBe(3);
    expect(evidence?.entrenchment.distinctAreas).toEqual(["billing", "orders", "shipping"]);
    expect(evidence?.usedSymbols).toEqual(["Order"]);
  });

  it("is reachable through the shared evidence dispatch", () => {
    const { files, changes } = repo(payAfter, payBefore);

    const result = buildRuleEvidence(
      "jev/no-shared-kernel-new-consumer",
      moduleCandidate("invoicing/pay.ts"),
      files,
      changes,
    );

    expect(result.handled).toBe(true);
    if (result.handled) expect(result.evidence).toBeDefined();
  });

  it("abstains for non-module candidates", () => {
    const { files, changes } = repo(payAfter, payBefore);

    expect(
      buildSharedKernelNewConsumerEvidence(nonModuleCandidate("invoicing/pay.ts"), files, changes),
    ).toBeUndefined();
  });

  it("abstains when the kernel edge is not new", () => {
    const { files, changes } = repo(payAfter, payAfter);

    expect(
      buildSharedKernelNewConsumerEvidence(moduleCandidate("invoicing/pay.ts"), files, changes),
    ).toBeUndefined();
  });

  it("abstains when the target has no shared-kernel markers", () => {
    const plain = `export function format(amount: number) {
  return String(amount);
}
`;
    const payUtil = `import { format } from "../util/format.js";
export function pay(amount: number) {
  return format(amount);
}
`;
    const files = [
      projectFile("util/format.ts", plain),
      projectFile("invoicing/pay.ts", payUtil),
      ...Array.from({ length: 9 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "invoicing/pay.ts",
      source: payUtil,
      oldSource: payBefore,
      changedLines: [{ start: 1, end: 1 }],
    }];

    expect(
      buildSharedKernelNewConsumerEvidence(moduleCandidate("invoicing/pay.ts"), files, changes),
    ).toBeUndefined();
  });

  it("abstains when the candidate area already consumes the kernel", () => {
    const files = [
      projectFile("shared/kernel.ts", kernel),
      projectFile("billing/invoice.ts", billingConsumer),
      projectFile("billing/pay.ts", payAfter),
      projectFile("shipping/label.ts", shippingConsumer),
      projectFile("orders/history.ts", ordersConsumer),
      ...Array.from({ length: 6 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "billing/pay.ts",
      source: payAfter,
      oldSource: payBefore,
      changedLines: [{ start: 1, end: 1 }],
    }];

    expect(
      buildSharedKernelNewConsumerEvidence(moduleCandidate("billing/pay.ts"), files, changes),
    ).toBeUndefined();
  });
});
