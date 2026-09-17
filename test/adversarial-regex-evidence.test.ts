import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildAdversarialRegexEvidence } from "../src/evidence/adversarial-regex.js";
import type { ProjectFile } from "../src/types.js";

function files(ownerSource: string, extra: ProjectFile[] = []): ProjectFile[] {
  return [{ filePath: "src/router.ts", source: ownerSource }, ...extra];
}

function changedFunction(ownerSource: string, extra: ProjectFile[] = []) {
  const projectFiles = files(ownerSource, extra);
  const candidate = extractCandidates("src/router.ts", ownerSource)
    .find(({ kind }) => kind === "function");
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no function candidate.");
  return { candidate, projectFiles };
}

describe("adversarial regex evidence", () => {
  it("reports a nested quantifier tested against a parameter", () => {
    const { candidate, projectFiles } = changedFunction(
      "export function matchRoute(path: string): boolean {\n"
      + "  const pattern = /(a+)+b/;\n"
      + "  return pattern.test(path);\n"
      + "}\n",
    );

    const evidence = buildAdversarialRegexEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "matchRoute", exported: true },
      patterns: [{ pattern: "(a+)+b", nestedQuantifier: true }],
      testedValues: [{ value: "path", valueSource: "parameter" }],
      mitigations: { lengthCap: false, linearEngine: false },
    });
  });

  it("reports a length cap mitigation", () => {
    const { candidate, projectFiles } = changedFunction(
      "export function matchRoute(path: string): boolean {\n"
      + "  if (path.length > 200) throw new Error(\"too long\");\n"
      + "  return /(a+)+b/.test(path);\n"
      + "}\n",
    );

    expect(buildAdversarialRegexEvidence(candidate, projectFiles)).toMatchObject({
      mitigations: { lengthCap: true },
    });
  });

  it("abstains when no pattern has risky quantification", () => {
    const { candidate, projectFiles } = changedFunction(
      "export function isDigits(value: string): boolean {\n"
      + "  return /^\\d+$/.test(value);\n"
      + "}\n",
    );

    expect(buildAdversarialRegexEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
