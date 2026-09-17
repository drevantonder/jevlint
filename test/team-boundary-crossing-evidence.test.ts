import { describe, expect, it } from "vitest";
import { buildTeamBoundaryCrossingEvidence } from "../src/evidence/team-boundary-crossing.js";
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

const calc = `export function calculateTotal(items: number[]) {
  return items.reduce((total, item) => total + item, 0);
}
`;

const shipBefore = `export function ship(order: string) {
  return order;
}
`;

const shipAfter = `import { calculateTotal } from "../billing/calc.js";
export function ship(order: string) {
  return String(calculateTotal([1])) + order;
}
`;

const owners = `# team ownership
/features/billing/ @org/billing
/features/shipping/ @org/shipping
/features/orders/ @org/orders
`;

function repo(shipSource: string, shipOld: string | null, includeOwners = true) {
  const files = [
    projectFile("features/billing/calc.ts", calc),
    projectFile("features/billing/index.ts", `export { calculateTotal } from "./calc.js";\n`),
    projectFile("features/shipping/ship.ts", shipSource),
    projectFile("features/orders/cart.ts", `export function cart() {\n  return 1;\n}\n`),
    ...(includeOwners ? [projectFile(".github/CODEOWNERS", owners)] : []),
    ...Array.from({ length: 7 }, (_, index) => projectFile(`features/extra/widget-${index}.ts`)),
  ];
  const changes: SourceFile[] = [{
    filePath: "features/shipping/ship.ts",
    source: shipSource,
    oldSource: shipOld,
    changedLines: [{ start: 1, end: 1 }],
  }];
  return { files, changes };
}

describe("team boundary crossing evidence", () => {
  it("captures a new edge into another team's area with no precedent", () => {
    const { files, changes } = repo(shipAfter, shipBefore);

    const evidence = buildTeamBoundaryCrossingEvidence(
      moduleCandidate("features/shipping/ship.ts"),
      files,
      changes,
    );

    expect(evidence?.ownersFile).toBe(".github/CODEOWNERS");
    expect(evidence?.crossings).toHaveLength(1);
    expect(evidence?.crossings[0]).toMatchObject({
      specifier: "../billing/calc.js",
      resolved: "features/billing/calc.ts",
      ownerTeam: "org/shipping",
      targetTeam: "org/billing",
      viaEntry: false,
    });
    expect(evidence?.crossings[0]?.targetEntry).toBe("features/billing/index.ts");
    expect(evidence?.precedent).toEqual([{
      ownerTeam: "org/shipping",
      targetTeam: "org/billing",
      existingEdges: 0,
    }]);
  });

  it("abstains when no ownership file is visible", () => {
    const { files, changes } = repo(shipAfter, shipBefore, false);

    expect(
      buildTeamBoundaryCrossingEvidence(moduleCandidate("features/shipping/ship.ts"), files, changes),
    ).toBeUndefined();
  });

  it("abstains when the new edge stays inside one team's area", () => {
    const sameTeam = `import { cart } from "../orders/cart.js";\nexport function ship() {\n  return cart();\n}\n`;
    const sameOwners = "/features/ @org/monorepo\n";
    const files = [
      projectFile("features/shipping/ship.ts", sameTeam),
      projectFile("features/orders/cart.ts", `export function cart() {\n  return 1;\n}\n`),
      projectFile("CODEOWNERS", sameOwners),
      ...Array.from({ length: 8 }, (_, index) => projectFile(`features/extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "features/shipping/ship.ts",
      source: sameTeam,
      oldSource: shipBefore,
      changedLines: [{ start: 1, end: 1 }],
    }];

    expect(
      buildTeamBoundaryCrossingEvidence(moduleCandidate("features/shipping/ship.ts"), files, changes),
    ).toBeUndefined();
  });

  it("abstains when the cross-team edge already existed", () => {
    const { files, changes } = repo(shipAfter, shipAfter);

    expect(
      buildTeamBoundaryCrossingEvidence(moduleCandidate("features/shipping/ship.ts"), files, changes),
    ).toBeUndefined();
  });

  it("abstains for non-module candidates", () => {
    const { files, changes } = repo(shipAfter, shipBefore);

    expect(
      buildTeamBoundaryCrossingEvidence(
        { ...moduleCandidate("features/shipping/ship.ts"), kind: "change" },
        files,
        changes,
      ),
    ).toBeUndefined();
  });
});
