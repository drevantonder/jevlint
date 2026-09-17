import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildMessageChainEvidence } from "../src/evidence/message-chain.js";
import type { ProjectFile } from "../src/types.js";

const orderSource = `import { Order } from "./models.js";

export function orderZip(order: Order): string {
  return order.getCustomer().getAddress().getZip();
}

export function orderCity(order: Order): string {
  return order.getCustomer().getAddress().getCity();
}
`;

const modelsSource = `export class Address {
  getZip(): string {
    return "00000";
  }
  getCity(): string {
    return "Springfield";
  }
}

export class Customer {
  getAddress(): Address {
    return new Address();
  }
}

export class Order {
  getCustomer(): Customer {
    return new Customer();
  }
}
`;

const receiptSource = `import { orderZip } from "./order.js";
import type { Order } from "./models.js";

export function receiptLine(order: Order): string {
  return "ZIP " + orderZip(order);
}
`;

function candidate(source: string, filePath: string) {
  return extractCandidates(filePath, source).find(({ kind }) => kind === "function");
}

describe("message chain evidence", () => {
  it("extracts deep navigation chains with repeated prefixes", () => {
    const files: ProjectFile[] = [
      { filePath: "src/order.ts", source: orderSource },
      { filePath: "src/models.ts", source: modelsSource },
      { filePath: "src/receipt.ts", source: receiptSource },
    ];
    const fn = candidate(orderSource, "src/order.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    const evidence = buildMessageChainEvidence(fn, files);

    expect(evidence).toMatchObject({
      function: { name: "orderZip", filePath: "src/order.ts" },
      chains: [expect.objectContaining({
        text: "order.getCustomer().getAddress().getZip()",
        depth: 4,
        pureNavigation: true,
      })],
      repeatedPrefixes: [],
      importedSources: ["./models.js"],
      callers: [expect.objectContaining({ filePath: "src/receipt.ts" })],
    });
  });

  it("abstains for shallow single-level calls", () => {
    const source = `export function double(value: number): number {
      return Math.max(value, 0) * 2;
    }
    `;
    const fn = candidate(source, "src/double.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildMessageChainEvidence(fn, [{ filePath: "src/double.ts", source }])).toBeUndefined();
  });
});
