import { describe, expect, it } from "vitest";
import { buildCrossContextTestReachEvidence } from "../src/evidence/cross-context-test-reach.js";
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

const fixture = `export function orderFixture() {
  return { id: "order-1", lines: [] as string[] };
}
export function customerFixture() {
  return { name: "Ada" };
}
`;

const shipBefore = `export function ship(id: string) {
  return id;
}
`;

const shipAfter = `import { orderFixture } from "../billing/fixtures/orders.js";
export function ship(id: string) {
  const order = orderFixture();
  return order.id + id;
}
`;

const ordersCart = `import { customerFixture } from "../billing/fixtures/orders.js";
export function cart() {
  return customerFixture().name;
}
`;

function repo(shipSource: string, shipOld: string | null, shipPath = "shipping/ship.ts") {
  const files = [
    projectFile("billing/fixtures/orders.ts", fixture),
    projectFile(shipPath, shipSource),
    projectFile("orders/cart.ts", ordersCart),
    ...Array.from({ length: 8 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
  ];
  const changes: SourceFile[] = [{
    filePath: shipPath,
    source: shipSource,
    oldSource: shipOld,
    changedLines: [{ start: 1, end: 1 }],
  }];
  return { files, changes };
}

describe("cross context test reach evidence", () => {
  it("captures a new runtime edge into another area's fixture sources", () => {
    const { files, changes } = repo(shipAfter, shipBefore);

    const evidence = buildCrossContextTestReachEvidence(
      moduleCandidate("shipping/ship.ts"),
      files,
      changes,
    );

    expect(evidence?.target).toBe("billing/fixtures/orders.ts");
    expect(evidence?.specifier).toBe("../billing/fixtures/orders.js");
    expect(evidence?.testMarkers).toMatchObject({ testFile: false, fixtureSegment: true });
    expect(evidence?.valueImport).toBe(true);
    expect(evidence?.usedSymbols).toEqual(["orderFixture"]);
    expect(evidence?.crossAreaImporters).toEqual(["orders/cart.ts"]);
  });

  it("is reachable through the shared evidence dispatch", () => {
    const { files, changes } = repo(shipAfter, shipBefore);

    const result = buildRuleEvidence(
      "jev/no-cross-context-test-reach",
      moduleCandidate("shipping/ship.ts"),
      files,
      changes,
    );

    expect(result.handled).toBe(true);
    if (result.handled) expect(result.evidence).toBeDefined();
  });

  it("abstains for non-module candidates", () => {
    const { files, changes } = repo(shipAfter, shipBefore);

    expect(
      buildCrossContextTestReachEvidence(
        { ...moduleCandidate("shipping/ship.ts"), id: "change_0", kind: "change" },
        files,
        changes,
      ),
    ).toBeUndefined();
  });

  it("abstains when the candidate itself is a test file", () => {
    const { files, changes } = repo(shipAfter, shipBefore, "shipping/ship.test.ts");

    expect(
      buildCrossContextTestReachEvidence(
        moduleCandidate("shipping/ship.test.ts"),
        files,
        changes,
      ),
    ).toBeUndefined();
  });

  it("abstains when the reach stays within one area", () => {
    const localShip = shipAfter.replace("../billing/fixtures/orders.js", "./fixtures/orders.js");
    const files = [
      projectFile("shipping/fixtures/orders.ts", fixture),
      projectFile("shipping/ship.ts", localShip),
      projectFile("orders/cart.ts", ordersCart),
      ...Array.from({ length: 8 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "shipping/ship.ts",
      source: localShip,
      oldSource: shipBefore,
      changedLines: [{ start: 1, end: 1 }],
    }];

    expect(
      buildCrossContextTestReachEvidence(moduleCandidate("shipping/ship.ts"), files, changes),
    ).toBeUndefined();
  });

  it("abstains when the fixture edge is not new", () => {
    const { files, changes } = repo(shipAfter, shipAfter);

    expect(
      buildCrossContextTestReachEvidence(moduleCandidate("shipping/ship.ts"), files, changes),
    ).toBeUndefined();
  });
});
