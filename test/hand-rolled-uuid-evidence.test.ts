import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildHandRolledUuidEvidence } from "../src/evidence/hand-rolled-uuid.js";
import { buildPredictableTokenEvidence } from "../src/evidence/predictable-token.js";
import type { ProjectFile } from "../src/types.js";

const RULE = "jev/no-hand-rolled-uuid";

function project(ownerSource: string, excerpt: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/ids.ts", source: ownerSource }];
  const candidate = extractCandidates("src/ids.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes(excerpt));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no id candidate.");
  return { candidate, projectFiles };
}

const SMELLY = "export function newCorrelationId(): string {\n"
  + "  return \"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx\".replace(/[xy]/g, (char) => {\n"
  + "    const random = Math.floor(Math.random() * 16);\n"
  + "    return (char === \"x\" ? random : (random & 0x3) | 0x8).toString(16);\n"
  + "  });\n"
  + "}\n";

describe("hand rolled uuid wiring", () => {
  it("ships as a function judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({ scope: "function", message: expect.any(String) });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("passes uuid template candidates through dispatch", () => {
    const { candidate, projectFiles } = project(SMELLY, "newCorrelationId");

    const result = buildRuleEvidence(RULE, candidate, projectFiles);

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
  });
});

describe("hand rolled uuid evidence", () => {
  it("reports a v4 template assembled from Math.random", () => {
    const { candidate, projectFiles } = project(SMELLY, "newCorrelationId");

    const evidence = buildHandRolledUuidEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "newCorrelationId" },
      idKind: "uuid-template",
      randomCalls: expect.arrayContaining([expect.objectContaining({ call: expect.stringContaining("Math.random") })]),
      hasFixedPrefix: false,
    });
  });

  it("reports hex assembly with a fixed prefix as justification signal", () => {
    const { candidate, projectFiles } = project(
      "export function newOrderId(): string {\n"
        + "  const random = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, \"0\");\n"
        + "  return \"ord_\" + random;\n"
        + "}\n",
      "newOrderId",
    );

    const evidence = buildHandRolledUuidEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      idKind: "hex-assembly",
      hasFixedPrefix: true,
    });
  });

  it("stays silent where the predictable-token rule fires", () => {
    const { candidate, projectFiles } = project(
      "export function mintSessionToken(): string {\n"
        + "  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);\n"
        + "}\n",
      "mintSessionToken",
    );

    expect(buildPredictableTokenEvidence(candidate, projectFiles)).toBeDefined();
    expect(buildHandRolledUuidEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when no id-shaped assembly exists", () => {
    const { candidate, projectFiles } = project(
      "export function rollDie(): number {\n"
        + "  return Math.floor(Math.random() * 6) + 1;\n"
        + "}\n",
      "rollDie",
    );

    expect(buildHandRolledUuidEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
