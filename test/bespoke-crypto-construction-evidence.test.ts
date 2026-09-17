import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildBespokeCryptoConstructionEvidence } from "../src/evidence/bespoke-crypto-construction.js";
import { buildWeakCryptoPrimitiveEvidence } from "../src/evidence/weak-crypto-primitive.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/secrets.ts", source: ownerSource }];
  const candidate = extractCandidates("src/secrets.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("encrypt") || source.includes("hashPassword"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no crypto candidate.");
  return { candidate, projectFiles };
}

describe("bespoke crypto construction evidence", () => {
  it("reports an XOR cipher loop with byte iteration", () => {
    const { candidate, projectFiles } = project(
      "export function encrypt(data: string, key: string): string {\n"
      + "  let out = \"\";\n"
      + "  for (let index = 0; index < data.length; index += 1) {\n"
      + "    const mixed = data.charCodeAt(index) ^ key.charCodeAt(index % key.length);\n"
      + "    out += String.fromCharCode((mixed << 3) | (mixed >> 5));\n"
      + "  }\n"
      + "  return out;\n"
      + "}\n",
    );

    const evidence = buildBespokeCryptoConstructionEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "encrypt" },
      bitwiseOperations: expect.arrayContaining([expect.objectContaining({ operator: "^" })]),
      byteLoop: expect.stringContaining("charCodeAt"),
      namedPrimitiveCalls: [],
    });
  });

  it("stays silent where the weak-primitive rule fires", () => {
    const { candidate, projectFiles } = project(
      "import { createHash } from \"node:crypto\";\n"
      + "export function hashPassword(password: string): string {\n"
      + "  return createHash(\"md5\").update(password).digest(\"hex\");\n"
      + "}\n",
    );

    expect(buildWeakCryptoPrimitiveEvidence(candidate, projectFiles)).toBeDefined();
    expect(buildBespokeCryptoConstructionEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when the name carries no cryptographic meaning", () => {
    const source = "export function combineFlags(left: number, right: number): number {\n"
      + "  return (left << 2) | right;\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/secrets.ts", source }];
    const candidate = extractCandidates("src/secrets.ts", source)
      .filter(({ kind }) => kind === "function")
      .find(({ source: text }) => text.includes("combineFlags"));
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("Fixture has no candidate.");

    expect(buildBespokeCryptoConstructionEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
