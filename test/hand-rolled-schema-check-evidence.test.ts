import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";
import { extractCandidates } from "../src/candidates.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildHandRolledSchemaCheckEvidence } from "../src/evidence/hand-rolled-schema-check.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const RULE = "jev/no-hand-rolled-schema-check";
const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function functionCandidate(files: ProjectFile[], name: string): Candidate {
  const owner = files.find((file) => file.filePath.includes("validate"));
  expect(owner).toBeDefined();
  if (!owner) throw new Error("Fixture has no candidate file.");
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find((entry) => entry.kind === "function" && entry.source.includes(name));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error(`Fixture has no function containing ${name}.`);
  return candidate;
}

describe("hand rolled schema check wiring", () => {
  it("ships as a function judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "function",
      message: expect.any(String),
    });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("flags multi-field validation beside an installed validator", async () => {
    const files = await project("hand-rolled-schema-check-positive", [
      "package.json",
      "pnpm-lock.yaml",
      "src/validate.ts",
      "src/user-service.ts",
    ]);

    const result = buildRuleEvidence(RULE, functionCandidate(files, "validateUser"), files);

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
    if (!result.handled) return;
    expect(result.evidence).toMatchObject({
      ownedValidator: "zod",
      siblingImporters: ["src/user-service.ts"],
      lockfilePresent: true,
      typeofCheckCount: 4,
    });
  });

  it("abstains without an installed validator", () => {
    const source = `export function validateUser(input: unknown): string[] {
  const errors: string[] = [];
  if (typeof (input as Record<string, unknown>).name !== "string") errors.push("name");
  if (typeof (input as Record<string, unknown>).age !== "number") errors.push("age");
  return errors;
}
`;
    const candidate = extractCandidates("src/validate.ts", source)
      .find((entry) => entry.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(buildHandRolledSchemaCheckEvidence(candidate, [
      { filePath: "package.json", source: JSON.stringify({ dependencies: {} }) },
      { filePath: "src/validate.ts", source },
    ])).toBeUndefined();
  });

  it("abstains for a single-field check", async () => {
    const source = `export function isPresent(value: unknown): boolean {
  return typeof value === "string";
}
`;
    const candidate = extractCandidates("src/guard.ts", source)
      .find((entry) => entry.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;
    const files: ProjectFile[] = [
      { filePath: "package.json", source: JSON.stringify({ dependencies: { zod: "^3.0.0" } }) },
      { filePath: "src/guard.ts", source },
    ];
    expect(buildHandRolledSchemaCheckEvidence(candidate, files)).toBeUndefined();
  });

  it("abstains when the candidate already imports the validator", async () => {
    const files = await project("hand-rolled-schema-check-positive", [
      "package.json",
      "src/user-service.ts",
    ]);
    const owner = files.find((file) => file.filePath.includes("user-service"));
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find((entry) => entry.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(buildHandRolledSchemaCheckEvidence(candidate, files)).toBeUndefined();
  });
});