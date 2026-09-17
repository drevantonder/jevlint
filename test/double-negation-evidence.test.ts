import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDoubleNegationEvidence } from "../src/evidence/double-negation.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/flags.ts", source: ownerSource }];
  const candidate = extractCandidates("src/flags.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("check"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no check candidate.");
  return { candidate, projectFiles };
}

describe("double negation evidence", () => {
  it("counts stacked bangs resolving to a positive reading", () => {
    const { candidate, projectFiles } = project(
      "export function check(enabled: boolean): boolean {\n"
      + "  return !!enabled;\n"
      + "}\n",
    );

    const evidence = buildDoubleNegationEvidence(candidate, projectFiles);

    expect(evidence?.maxLayers).toBe(2);
    expect(evidence?.negations).toMatchObject([{ layers: 2, kind: "bang-stack" }]);
  });

  it("flags a single negation wrapping a negative-polarity name", () => {
    const { candidate, projectFiles } = project(
      "export function check(disabled: boolean): boolean {\n"
      + "  if (!disabled) {\n"
      + "    return true;\n"
      + "  }\n"
      + "  return false;\n"
      + "}\n",
    );

    const evidence = buildDoubleNegationEvidence(candidate, projectFiles);

    expect(evidence?.negations).toMatchObject([
      { layers: 1, wrapsNegativeName: true, negativeName: "disabled", kind: "bang-stack" },
    ]);
  });

  it("flags comparisons against false and inverted-polarity call edges", () => {
    const compared = project(
      "export function check(ready: boolean): boolean {\n"
      + "  return ready != false;\n"
      + "}\n",
    );
    expect(
      buildDoubleNegationEvidence(compared.candidate, compared.projectFiles)?.negations,
    ).toMatchObject([{ kind: "equality-against-boolean" }]);

    const inverted = project(
      "export function check(disableCache: boolean): boolean {\n"
      + "  return fetchRow(!disableCache);\n"
      + "}\n",
    );
    expect(
      buildDoubleNegationEvidence(inverted.candidate, inverted.projectFiles)?.negations,
    ).toMatchObject([
      { kind: "bang-stack", negativeName: "disableCache" },
      { kind: "inverted-polarity-call", negativeName: "disableCache" },
    ]);
  });

  it("abstains on single positive negations and negation-free bodies", () => {
    const single = project(
      "export function check(enabled: boolean): boolean {\n"
      + "  return !enabled;\n"
      + "}\n",
    );
    expect(buildDoubleNegationEvidence(single.candidate, single.projectFiles)).toBeUndefined();

    const plain = project("export function check(enabled: boolean): boolean {\n  return enabled;\n}\n");
    expect(buildDoubleNegationEvidence(plain.candidate, plain.projectFiles)).toBeUndefined();
  });

  it("abstains for non-function candidates and dispatches the rule id", () => {
    const { candidate, projectFiles } = project(
      "export function check(enabled: boolean): boolean {\n  return !!enabled;\n}\n",
    );
    expect(buildDoubleNegationEvidence({ ...candidate, kind: "comment" }, projectFiles)).toBeUndefined();
    expect(buildRuleEvidence("jev/no-double-negation", candidate, projectFiles)).toMatchObject({
      handled: true,
      evidence: expect.anything(),
    });
  });
});
