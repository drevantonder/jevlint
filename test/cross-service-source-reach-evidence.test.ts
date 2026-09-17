import { describe, expect, it } from "vitest";
import { buildCrossServiceSourceReachEvidence } from "../src/evidence/cross-service-source-reach.js";
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

const shipRelative = `import { calculateTotal } from "../../billing/src/calc.js";
export function ship(order: string) {
  return String(calculateTotal([1])) + order;
}
`;

const shipPackaged = `import { calculateTotal } from "@acme/billing/calc";
export function ship(order: string) {
  return String(calculateTotal([1])) + order;
}
`;

function manifests() {
  return [
    projectFile("package.json", JSON.stringify({ name: "acme-root", workspaces: ["services/*"] })),
    projectFile("services/billing/package.json", JSON.stringify({ name: "@acme/billing", version: "1.0.0" })),
    projectFile("services/shipping/package.json", JSON.stringify({ name: "@acme/shipping", version: "1.0.0" })),
  ];
}

function repo(shipSource: string, shipOld: string | null, extra: ProjectFile[] = manifests()) {
  const files = [
    projectFile("services/billing/src/calc.ts", calc),
    projectFile("services/billing/src/index.ts", `export { calculateTotal } from "./calc.js";\n`),
    projectFile("services/shipping/src/ship.ts", shipSource),
    ...extra,
    ...Array.from({ length: 7 }, (_, index) => projectFile(`services/extra/widget-${index}.ts`)),
  ];
  const changes: SourceFile[] = [{
    filePath: "services/shipping/src/ship.ts",
    source: shipSource,
    oldSource: shipOld,
    changedLines: [{ start: 1, end: 1 }],
  }];
  return { files, changes };
}

describe("cross service source reach evidence", () => {
  it("captures a new relative reach across a manifest boundary", () => {
    const { files, changes } = repo(shipRelative, shipBefore);

    const evidence = buildCrossServiceSourceReachEvidence(
      moduleCandidate("services/shipping/src/ship.ts"),
      files,
      changes,
    );

    expect(evidence?.manifests).toHaveLength(3);
    expect(evidence?.crossings).toHaveLength(1);
    expect(evidence?.crossings[0]).toMatchObject({
      specifier: "../../billing/src/calc.js",
      resolved: "services/billing/src/calc.ts",
      ownerUnit: "@acme/shipping",
      targetUnit: "@acme/billing",
      coupling: "relative",
      viaEntry: false,
    });
  });

  it("captures a workspace package-name edge as versioned coupling", () => {
    const { files, changes } = repo(shipPackaged, shipBefore);

    const evidence = buildCrossServiceSourceReachEvidence(
      moduleCandidate("services/shipping/src/ship.ts"),
      files,
      changes,
    );

    expect(evidence?.crossings).toHaveLength(1);
    expect(evidence?.crossings[0]).toMatchObject({
      specifier: "@acme/billing/calc",
      resolved: "services/billing/src/calc.ts",
      coupling: "workspace-package",
    });
  });

  it("abstains in a single-manifest repository", () => {
    const single = [projectFile("package.json", JSON.stringify({ name: "acme-mono" }))];
    const { files, changes } = repo(shipRelative, shipBefore, single);

    expect(
      buildCrossServiceSourceReachEvidence(
        moduleCandidate("services/shipping/src/ship.ts"),
        files,
        changes,
      ),
    ).toBeUndefined();
  });

  it("abstains when the edge stays inside one unit", () => {
    const internal = `import { ship } from "./ship.js";\nexport function dispatch() {\n  return ship("x");\n}\n`;
    const { files, changes } = repo(internal, shipBefore);

    expect(
      buildCrossServiceSourceReachEvidence(
        moduleCandidate("services/shipping/src/ship.ts"),
        files,
        changes,
      ),
    ).toBeUndefined();
  });

  it("abstains when the cross-unit edge already existed", () => {
    const { files, changes } = repo(shipRelative, shipRelative);

    expect(
      buildCrossServiceSourceReachEvidence(
        moduleCandidate("services/shipping/src/ship.ts"),
        files,
        changes,
      ),
    ).toBeUndefined();
  });
});
