import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildPartitionedFatInterfaceEvidence } from "../src/evidence/partitioned-fat-interface.js";
import type { ProjectFile } from "../src/types.js";

const REGISTRY = `export class ServiceRegistry {
  addAdmin(name: string): void {
  }
  removeAdmin(name: string): void {
  }
  addCustomer(name: string): void {
  }
  removeCustomer(name: string): void {
  }
}
`;

const ADMIN_CLIENT = `import { ServiceRegistry } from "./registry.js";
const registry = new ServiceRegistry();
export function onboard(name: string): void {
  registry.addAdmin(name);
  registry.removeAdmin("legacy");
}
`;

const SHOP_CLIENT = `import { ServiceRegistry } from "./registry.js";
const registry = new ServiceRegistry();
export function checkout(name: string): void {
  registry.addCustomer(name);
  registry.removeCustomer("guest");
}
`;

function project(ownerSource: string, extra: ProjectFile[] = [], className = "ServiceRegistry") {
  const projectFiles: ProjectFile[] = [
    { filePath: "src/registry.ts", source: ownerSource },
    { filePath: "src/admin.ts", source: ADMIN_CLIENT },
    { filePath: "src/shop.ts", source: SHOP_CLIENT },
    ...extra,
  ];
  const candidate = extractCandidates("src/registry.ts", ownerSource)
    .filter(({ kind }) => kind === "abstraction")
    .find(({ source }) => source.includes(className));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no ServiceRegistry candidate.");
  return { candidate, projectFiles };
}

describe("partitioned fat interface evidence", () => {
  it("partitions admin and customer callers into disjoint method groups", () => {
    const { candidate, projectFiles } = project(REGISTRY);

    const evidence = buildPartitionedFatInterfaceEvidence(candidate, projectFiles);

    expect(evidence?.class).toMatchObject({ name: "ServiceRegistry", exported: true });
    expect(evidence?.methods.map(({ name }) => name)).toEqual([
      "addAdmin",
      "removeAdmin",
      "addCustomer",
      "removeCustomer",
    ]);
    expect(evidence?.methods.find(({ name }) => name === "addAdmin")?.callerFiles).toEqual([
      "src/admin.ts",
    ]);
    expect(evidence?.methods.find(({ name }) => name === "addCustomer")?.callerFiles).toEqual([
      "src/shop.ts",
    ]);
    expect(evidence?.disjointPairs).toContainEqual({ left: "addAdmin", right: "addCustomer" });
    expect(evidence?.coverage).toMatchObject({ totalMethods: 4, totalCallerFiles: 2 });
  });

  it("abstains when the class has fewer than three public methods", () => {
    const small = `export class Pair {
  first(): void {
  }
  second(): void {
  }
}
`;
    const { candidate, projectFiles } = project(small, [], "Pair");

    expect(buildPartitionedFatInterfaceEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when no caller evidence exists", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/registry.ts", source: REGISTRY }];
    const candidate = extractCandidates("src/registry.ts", REGISTRY)
      .filter(({ kind }) => kind === "abstraction")
      .find(({ source }) => source.includes("ServiceRegistry"));
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("Fixture has no ServiceRegistry candidate.");

    expect(buildPartitionedFatInterfaceEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
