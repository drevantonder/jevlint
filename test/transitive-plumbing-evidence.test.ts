import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildTransitivePlumbingEvidence } from "../src/evidence/transitive-plumbing.js";
import type { ProjectFile } from "../src/types.js";

function chainProject() {
  const projectFiles: ProjectFile[] = [
    {
      filePath: "src/handle.ts",
      source: "export function handle(tenantId: string): string {\n"
        + "  return authorize(tenantId);\n"
        + "}\n"
        + "function authorize(tenantId: string): string {\n"
        + "  return load(tenantId);\n"
        + "}\n",
    },
    {
      filePath: "src/load.ts",
      source: "export function load(tenantId: string): string {\n"
        + "  return read(tenantId);\n"
        + "}\n"
        + "function read(tenantId: string): string {\n"
        + "  return tenantId.trim();\n"
        + "}\n",
    },
  ];
  const candidate = extractCandidates("src/handle.ts", projectFiles[0]?.source ?? "")
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("handle"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no handle candidate.");
  return { candidate, projectFiles };
}

describe("transitive plumbing evidence", () => {
  it("counts a three-link chain for a value never read above the leaf", () => {
    const { candidate, projectFiles } = chainProject();

    const evidence = buildTransitivePlumbingEvidence(candidate, projectFiles);

    expect(evidence?.plumbedParams).toMatchObject([{ name: "tenantId", downstreamParamMatch: true }]);
    expect(evidence?.chainDepth).toBeGreaterThanOrEqual(3);
    expect(evidence?.repository.sameNamePassThrough.length).toBeGreaterThan(0);
  });

  it("abstains when the function reads the value for a decision", () => {
    const source = "export function handle(tenantId: string): string {\n"
      + "  if (tenantId.length === 0) {\n"
      + "    throw new Error(\"missing tenant\");\n"
      + "  }\n"
      + "  return authorize(tenantId);\n"
      + "}\n"
      + "function authorize(tenantId: string): string {\n"
      + "  return tenantId;\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/handle.ts", source }];
    const candidate = extractCandidates("src/handle.ts", source)
      .filter(({ kind }) => kind === "function")
      .find(({ source: text }) => text.includes("handle"));
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("Fixture has no handle candidate.");

    expect(buildTransitivePlumbingEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains below three links", () => {
    const source = "export function handle(tenantId: string): string {\n"
      + "  return read(tenantId);\n"
      + "}\n"
      + "function read(tenantId: string): string {\n"
      + "  return tenantId.trim();\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/handle.ts", source }];
    const candidate = extractCandidates("src/handle.ts", source)
      .filter(({ kind }) => kind === "function")
      .find(({ source: text }) => text.includes("handle"));
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("Fixture has no handle candidate.");

    expect(buildTransitivePlumbingEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains for non-function candidates and dispatches the rule id", () => {
    const { candidate, projectFiles } = chainProject();
    expect(buildTransitivePlumbingEvidence({ ...candidate, kind: "comment" }, projectFiles)).toBeUndefined();
    expect(buildRuleEvidence("jev/no-transitive-plumbing", candidate, projectFiles)).toMatchObject({
      handled: true,
      evidence: expect.anything(),
    });
  });
});
