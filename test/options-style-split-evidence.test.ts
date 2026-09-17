import { describe, expect, it } from "vitest";
import { buildOptionsStyleSplitEvidence } from "../src/evidence/options-style-split.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

const owner = `export function createOrder(items: string[], address: string): string {
  return items.join(",") + address;
}
export function cancelOrder({ orderId }: { orderId: string }): string {
  return orderId;
}
export function refundOrder({ orderId, amount }: { orderId: string; amount: number }): string {
  return orderId + String(amount);
}
`;

const uniform = `export function createOrder(items: string[], address: string): string {
  return items.join(",") + address;
}
export function cancelOrder(orderId: string): string {
  return orderId;
}
`;

const caller = `import { createOrder } from "./shop.js";
export function checkout(items: string[]): string {
  return createOrder(items, "home");
}
`;

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

function repo(ownerSource: string, ownerOld: string | null) {
  const files: ProjectFile[] = [
    { filePath: "features/shop/shop.ts", source: ownerSource },
    { filePath: "features/shop/cart.ts", source: caller.replace("./shop.js", "./shop.js") },
    ...Array.from(
      { length: 9 },
      (_, index) => ({ filePath: `features/extra/widget-${index}.ts`, source: "export const value = 1;\n" }),
    ),
  ];
  const changes: SourceFile[] = [{
    filePath: "features/shop/shop.ts",
    source: ownerSource,
    oldSource: ownerOld,
    changedLines: [{ start: 1, end: 2 }],
  }];
  return { files, changes };
}

describe("options style split evidence", () => {
  it("reports mixed styles with the majority and caller samples", () => {
    const { files, changes } = repo(owner, uniform);

    const evidence = buildOptionsStyleSplitEvidence(moduleCandidate("features/shop/shop.ts"), files, changes);

    expect(evidence?.exports).toEqual([
      { name: "cancelOrder", style: "options", arity: 1 },
      { name: "createOrder", style: "positional", arity: 2 },
      { name: "refundOrder", style: "options", arity: 1 },
    ]);
    expect(evidence?.majority).toBe("options");
    expect(evidence?.mixedArityGroups).toEqual([]);
    expect(evidence?.callers).toContainEqual({
      function: "createOrder",
      style: "positional",
      calls: [{
        filePath: "features/shop/cart.ts",
        call: expect.stringContaining("createOrder"),
        caller: "checkout(items: string[])",
        callerStyle: "positional",
      }],
    });
  });

  it("flags same-arity siblings on opposite styles", () => {
    const split = `export function fetchUser(userId: string): string {
  return userId;
}
export function deleteUser({ userId }: { userId: string }): string {
  return userId;
}
`;
    const before = `export function fetchUser(userId: string): string {
  return userId;
}
`;
    const { files, changes } = repo(split, before);

    const evidence = buildOptionsStyleSplitEvidence(moduleCandidate("features/shop/shop.ts"), files, changes);

    expect(evidence?.majority).toBe("tie");
    expect(evidence?.mixedArityGroups).toEqual([{ arity: 1, names: ["deleteUser", "fetchUser"] }]);
    expect(evidence?.callers.map(({ function: name }) => name).sort()).toEqual([
      "deleteUser",
      "fetchUser",
    ]);
  });

  it("abstains when every export shares one style", () => {
    const { files, changes } = repo(uniform, owner);
    expect(buildOptionsStyleSplitEvidence(moduleCandidate("features/shop/shop.ts"), files, changes))
      .toBeUndefined();
  });
});
