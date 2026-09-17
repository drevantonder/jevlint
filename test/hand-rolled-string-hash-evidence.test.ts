import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildHandRolledStringHashEvidence } from "../src/evidence/hand-rolled-string-hash.js";
import { buildWeakCryptoPrimitiveEvidence } from "../src/evidence/weak-crypto-primitive.js";
import type { ProjectFile } from "../src/types.js";

const RULE = "jev/no-hand-rolled-string-hash";

function project(ownerSource: string, excerpt: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/hash.ts", source: ownerSource }];
  const candidate = extractCandidates("src/hash.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes(excerpt));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no hash candidate.");
  return { candidate, projectFiles };
}

const SMELLY = "import { createHash } from \"node:crypto\";\n"
  + "export function fingerprintKey(key: string): string {\n"
  + "  return createHash(\"sha256\").update(key).digest(\"hex\").slice(0, 8);\n"
  + "}\n"
  + "export function bucketHash(value: string): number {\n"
  + "  let hash = 5381;\n"
  + "  for (let index = 0; index < value.length; index += 1) {\n"
  + "    hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0;\n"
  + "  }\n"
  + "  return hash;\n"
  + "}\n";

describe("hand rolled string hash wiring", () => {
  it("ships as a function judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({ scope: "function", message: expect.any(String) });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("passes hash fold candidates through dispatch", () => {
    const { candidate, projectFiles } = project(SMELLY, "bucketHash");

    const result = buildRuleEvidence(RULE, candidate, projectFiles);

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
  });
});

describe("hand rolled string hash evidence", () => {
  it("reports a djb2 fold beside node:crypto usage", () => {
    const { candidate, projectFiles } = project(SMELLY, "bucketHash");

    const evidence = buildHandRolledStringHashEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "bucketHash" },
      algorithmFamily: "djb2",
      foldOperations: expect.arrayContaining(["<<", "|"]),
      nodeCryptoInScope: true,
      seedable: false,
    });
  });

  it("stays silent where the weak-primitive rule fires", () => {
    const { candidate, projectFiles } = project(
      "import { createHash } from \"node:crypto\";\n"
        + "export function hashPassword(password: string): string {\n"
        + "  return createHash(\"md5\").update(password).digest(\"hex\");\n"
        + "}\n",
      "hashPassword",
    );

    expect(buildWeakCryptoPrimitiveEvidence(candidate, projectFiles)).toBeDefined();
    expect(buildHandRolledStringHashEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when the fold sits in a security-named function", () => {
    const { candidate, projectFiles } = project(
      "export function signPayload(payload: string, secret: string): number {\n"
        + "  let hash = 0;\n"
        + "  const input = payload + secret;\n"
        + "  for (let index = 0; index < input.length; index += 1) {\n"
        + "    hash = ((hash << 5) ^ hash ^ input.charCodeAt(index)) | 0;\n"
        + "  }\n"
        + "  return hash;\n"
        + "}\n",
      "signPayload",
    );

    expect(buildHandRolledStringHashEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when no bitwise fold exists", () => {
    const { candidate, projectFiles } = project(
      "export function checksumTotal(values: number[]): number {\n"
        + "  let total = 0;\n"
        + "  for (const value of values) total += value;\n"
        + "  return total;\n"
        + "}\n",
      "checksumTotal",
    );

    expect(buildHandRolledStringHashEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
