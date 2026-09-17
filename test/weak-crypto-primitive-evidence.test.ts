import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildWeakCryptoPrimitiveEvidence } from "../src/evidence/weak-crypto-primitive.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `import { createHash } from "node:crypto";
export function verifyPassword(password: string, stored: string) {
  const digest = createHash("md5").update(password).digest("hex");
  return digest === stored;
}
`;

const checksum = `import { createHash } from "node:crypto";
export function cacheKey(body: string) {
  return createHash("md5").update(body).digest("hex");
}
`;

const clean = `import { createHash } from "node:crypto";
export function verifyPassword(password: string, stored: string) {
  const digest = createHash("sha256").update(password).digest("hex");
  return digest === stored;
}
`;

function project(source: string, filePath = "src/auth.ts", extra: ProjectFile[] = []) {
  return { files: [{ filePath, source }, ...extra], filePath };
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("weak crypto primitive evidence", () => {
  it("captures an md5 password digest compared against a stored value", () => {
    const { files, filePath } = project(smelly);
    const evidence = buildWeakCryptoPrimitiveEvidence(
      candidateFor(smelly, filePath, "verifyPassword"),
      files,
    );

    expect(evidence).toMatchObject({
      function: { name: "verifyPassword", exported: true },
      weakCalls: [{
        callee: "createHash",
        algorithm: "md5",
        position: "hash",
        guardPosition: "credential-comparison",
        comparedAgainstStored: true,
      }],
      cryptoImports: ["node:crypto"],
    });
  });

  it("marks a checksum-position digest while still reporting", () => {
    const { files, filePath } = project(checksum);
    const evidence = buildWeakCryptoPrimitiveEvidence(
      candidateFor(checksum, filePath, "cacheKey"),
      files,
    );

    expect(evidence?.weakCalls).toHaveLength(1);
    expect(evidence?.weakCalls[0]).toMatchObject({
      algorithm: "md5",
      guardPosition: "checksum-cache",
    });
  });

  it("abstains when only a currently accepted primitive is used", () => {
    const { files, filePath } = project(clean);
    expect(buildWeakCryptoPrimitiveEvidence(
      candidateFor(clean, filePath, "verifyPassword"),
      files,
    )).toBeUndefined();
  });
});
