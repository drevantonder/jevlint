import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildLayerSkippingCallEvidence } from "../src/evidence/layer-skipping-call.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

const STORE = `export function readRow(id: string): string {
  return id;
}
`;

const SERVICE = `import { readRow } from "../db/orderStore.js";
export function getOrder(id: string): string {
  if (!id) throw new Error("missing id");
  return readRow(id);
}
`;

const HANDLER = `import { getOrder } from "../services/orderService.js";
import { readRow } from "../db/orderStore.js";
export function handle(id: string): string {
  getOrder(id);
  return readRow(id);
}
`;

function project(handlerSource: string, serviceSource: string, oldSource: string | null = null) {
  const projectFiles: ProjectFile[] = [
    { filePath: "routes/order.ts", source: handlerSource },
    { filePath: "services/orderService.ts", source: serviceSource },
    { filePath: "db/orderStore.ts", source: STORE },
  ];
  const candidate = extractCandidates("routes/order.ts", handlerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("handle"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no handle candidate.");
  const changes: SourceFile[] = [{
    filePath: "routes/order.ts",
    source: handlerSource,
    oldSource,
    changedLines: [{ start: 1, end: 6 }],
  }];
  return { candidate, projectFiles, changes };
}

describe("layer skipping call evidence", () => {
  it("captures a direct store call past a guard-bearing service", () => {
    const { candidate, projectFiles, changes } = project(HANDLER, SERVICE, null);

    const evidence = buildLayerSkippingCallEvidence(candidate, projectFiles, changes);

    expect(evidence?.callerLayer).toBe("transport");
    expect(evidence?.bypasses).toHaveLength(1);
    expect(evidence?.bypasses[0]).toMatchObject({
      callee: "readRow",
      importedFrom: "../db/orderStore.js",
      importPreExists: false,
      targetModule: "db/orderStore.ts",
      targetLayer: "adapter",
    });
    expect(evidence?.bypasses[0]?.intermediary).toHaveLength(1);
    expect(evidence?.bypasses[0]?.intermediary[0]).toMatchObject({
      filePath: "services/orderService.ts",
      layer: "application",
    });
    expect(evidence?.bypasses[0]?.intermediary[0]?.guardExcerpts.length).toBeGreaterThan(0);
  });

  it("marks the import as pre-existing when the edge predates the change", () => {
    const { candidate, projectFiles, changes } = project(HANDLER, SERVICE, HANDLER);

    const evidence = buildLayerSkippingCallEvidence(candidate, projectFiles, changes);

    expect(evidence?.bypasses[0]?.importPreExists).toBe(true);
  });

  it("abstains when no imported intermediate reaches the target", () => {
    const standalone = `export function getOrder(id: string): string {
  return id;
}
`;
    const { candidate, projectFiles, changes } = project(HANDLER, standalone, null);

    expect(buildLayerSkippingCallEvidence(candidate, projectFiles, changes)).toBeUndefined();
  });

  it("abstains for non-function candidates", () => {
    const { projectFiles, changes } = project(HANDLER, SERVICE, null);
    const nonFunction: Candidate = {
      id: "comment_0",
      kind: "comment",
      filePath: "routes/order.ts",
      source: "// note",
      start: 0,
      end: 8,
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 9,
    };

    expect(buildLayerSkippingCallEvidence(nonFunction, projectFiles, changes)).toBeUndefined();
  });
});
