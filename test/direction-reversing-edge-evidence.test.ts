import { describe, expect, it } from "vitest";
import { buildDirectionReversingEdgeEvidence } from "../src/evidence/direction-reversing-edge.js";
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

const core = `export function coreTotal(lines: number[]) {
  return lines.reduce((total, line) => total + line, 0);
}
`;

const helper = `export function helperLabel(value: string) {
  return value.trim();
}
`;

const summary = `export function summarize(lines: string[]) {
  return lines.join(", ");
}
`;

function shippingImporter(): string {
  return `import { report } from "../billing/reporter.js";
export function dispatch(lines: string[]) {
  return report(lines);
}
`;
}

const reporterBefore = `export function report(lines: string[]) {
  return lines.length;
}
`;

const reporterAfter = `import { summarize } from "../shipping/summary.js";
export function report(lines: string[]) {
  return summarize(lines);
}
`;

function repo(reporterSource: string, reporterOld: string | null, shippingSources: string[]) {
  const files = [
    projectFile("billing/reporter.ts", reporterSource),
    projectFile("billing/core.ts", core),
    projectFile("billing/helper.ts", helper),
    projectFile("shipping/summary.ts", summary),
    ...shippingSources.map((source, index) => projectFile(`shipping/route-${index}.ts`, source)),
    ...Array.from({ length: 5 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
  ];
  const changes: SourceFile[] = [{
    filePath: "billing/reporter.ts",
    source: reporterSource,
    oldSource: reporterOld,
    changedLines: [{ start: 1, end: 1 }],
  }];
  return { files, changes };
}

describe("direction reversing edge evidence", () => {
  it("captures a new edge back against an established one-way history", () => {
    const { files, changes } = repo(reporterAfter, reporterBefore, [shippingImporter(), shippingImporter()]);

    const evidence = buildDirectionReversingEdgeEvidence(
      moduleCandidate("billing/reporter.ts"),
      files,
      changes,
    );

    expect(evidence?.newEdge).toMatchObject({
      specifier: "../shipping/summary.js",
      resolved: "shipping/summary.ts",
      targetArea: "shipping",
    });
    expect(evidence?.incoming.count).toBe(2);
    expect(evidence?.incoming.files).toEqual(["shipping/route-0.ts", "shipping/route-1.ts"]);
    expect(evidence?.priorOutboundToArea).toBe(0);
    expect(evidence?.cycleClosed).toBe(false);
  });

  it("is reachable through the shared evidence dispatch", () => {
    const { files, changes } = repo(reporterAfter, reporterBefore, [shippingImporter(), shippingImporter()]);

    const result = buildRuleEvidence(
      "jev/no-direction-reversing-edge",
      moduleCandidate("billing/reporter.ts"),
      files,
      changes,
    );

    expect(result.handled).toBe(true);
    if (result.handled) expect(result.evidence).toBeDefined();
  });

  it("abstains for non-module candidates", () => {
    const { files, changes } = repo(reporterAfter, reporterBefore, [shippingImporter(), shippingImporter()]);

    expect(
      buildDirectionReversingEdgeEvidence(
        { ...moduleCandidate("billing/reporter.ts"), id: "change_0", kind: "change" },
        files,
        changes,
      ),
    ).toBeUndefined();
  });

  it("abstains when the incoming direction is a single stray import", () => {
    const { files, changes } = repo(reporterAfter, reporterBefore, [shippingImporter()]);

    expect(
      buildDirectionReversingEdgeEvidence(moduleCandidate("billing/reporter.ts"), files, changes),
    ).toBeUndefined();
  });

  it("abstains when no incoming history establishes a direction", () => {
    const lone = `export function dispatch(lines: string[]) {
  return lines.length;
}
`;
    const { files, changes } = repo(reporterAfter, reporterBefore, [lone, lone]);

    expect(
      buildDirectionReversingEdgeEvidence(moduleCandidate("billing/reporter.ts"), files, changes),
    ).toBeUndefined();
  });

  it("abstains when the new edge closes a dependency cycle", () => {
    const cyclicSummary = `import { report } from "../billing/reporter.js";
export function summarize(lines: string[]) {
  return String(report(lines));
}
`;
    const files = [
      projectFile("billing/reporter.ts", reporterAfter),
      projectFile("billing/core.ts", core),
      projectFile("billing/helper.ts", helper),
      projectFile("shipping/summary.ts", cyclicSummary),
      projectFile("shipping/route-0.ts", shippingImporter()),
      projectFile("shipping/route-1.ts", shippingImporter()),
      ...Array.from({ length: 5 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "billing/reporter.ts",
      source: reporterAfter,
      oldSource: reporterBefore,
      changedLines: [{ start: 1, end: 1 }],
    }];

    expect(
      buildDirectionReversingEdgeEvidence(moduleCandidate("billing/reporter.ts"), files, changes),
    ).toBeUndefined();
  });
});
