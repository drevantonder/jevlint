import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildShadowedMeaningEvidence } from "../src/evidence/shadowed-meaning.js";
import type { ProjectFile } from "../src/types.js";

const RULE = "jev/no-shadowed-meaning";

const shadowedImport = `import { client } from "./client";
export function charge(client: TestClient, amount: number) {
  return client.bill(amount);
}
`;

const shadowedModule = `const mode = "live";
export function describe(mode: string) {
  return mode.toUpperCase();
}
`;

const conventionalCatch = `import { error } from "./errors";
export function load(path: string) {
  try {
    return read(path);
  } catch (error) {
    return String(error);
  }
}
`;

const clean = `import { client } from "./client";
export function charge(amount: number) {
  return client.bill(amount);
}
`;

function project(source: string, filePath = "src/billing.ts"): ProjectFile[] {
  return [{ filePath, source }];
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("shadowed meaning evidence", () => {
  it("ships as a function judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "function",
      message: expect.any(String),
    });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("pairs a shadowing parameter with its imported outer meaning", () => {
    const filePath = "src/billing.ts";
    const evidence = buildShadowedMeaningEvidence(
      candidateFor(shadowedImport, filePath, "charge"),
      project(shadowedImport, filePath),
    );

    expect(evidence).toMatchObject({
      function: { name: "charge", exported: true },
      pairs: [{ name: "client", inner: { kind: "param" }, outer: { kind: "import" } }],
    });
    expect(evidence?.pairs[0]?.inner.typeText).toContain("TestClient");
    expect(evidence?.pairs[0]?.outer.typeText).toContain("./client");
  });

  it("pairs a shadowing parameter with its module-level meaning", () => {
    const filePath = "src/mode.ts";
    const evidence = buildShadowedMeaningEvidence(
      candidateFor(shadowedModule, filePath, "describe"),
      project(shadowedModule, filePath),
    );

    expect(evidence?.pairs).toMatchObject([
      { name: "mode", inner: { kind: "param" }, outer: { kind: "module-binding" } },
    ]);
  });

  it("keeps conventional catch shadowing eligible as the low-meaning shape", () => {
    const filePath = "src/load.ts";
    const evidence = buildShadowedMeaningEvidence(
      candidateFor(conventionalCatch, filePath, "load"),
      project(conventionalCatch, filePath),
    );

    expect(evidence?.pairs).toMatchObject([
      { name: "error", inner: { kind: "catch-param" }, outer: { kind: "import" } },
    ]);
  });

  it("abstains when no outer name is reused", () => {
    const filePath = "src/billing.ts";
    expect(buildShadowedMeaningEvidence(
      candidateFor(clean, filePath, "charge"),
      project(clean, filePath),
    )).toBeUndefined();
  });

  it("routes through the shared dispatch", () => {
    const filePath = "src/billing.ts";
    const files = project(shadowedImport, filePath);
    const result = buildRuleEvidence(
      RULE,
      candidateFor(shadowedImport, filePath, "charge"),
      files,
    );

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
  });
});
