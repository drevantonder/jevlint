import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnexplainedDomainThresholdEvidence } from "../src/evidence/unexplained-domain-threshold.js";
import type { ProjectFile } from "../src/types.js";

const SMELLY = `export function fetchWithRetry(url: string): string {
  let retries = 0;
  while (retries > 3) {
    retries += 1;
  }
  return url;
}
`;

const NAMED = `const MAX_RETRIES = 3;

export function fetchWithRetry(url: string): string {
  let retries = 0;
  while (retries > MAX_RETRIES) {
    retries += 1;
  }
  return url;
}
`;

const CLEAN = `export function identity(url: string): string {
  return url;
}
`;

function candidate(source: string, filePath: string) {
  return extractCandidates(filePath, source).find(({ kind }) => kind === "function");
}

describe("unexplained domain threshold evidence", () => {
  it("reports a bare retry cap with no named constant", () => {
    const files: ProjectFile[] = [{ filePath: "src/fetch.ts", source: SMELLY }];
    const fn = candidate(SMELLY, "src/fetch.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    const evidence = buildUnexplainedDomainThresholdEvidence(fn, files);

    expect(evidence).toMatchObject({
      function: { name: "fetchWithRetry", filePath: "src/fetch.ts" },
      thresholds: [
        expect.objectContaining({ kind: "comparison", value: 3, selfEvident: false }),
      ],
    });
  });

  it("abstains when the comparison uses a named constant", () => {
    const files: ProjectFile[] = [{ filePath: "src/fetch.ts", source: NAMED }];
    const fn = candidate(NAMED, "src/fetch.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildUnexplainedDomainThresholdEvidence(fn, files)).toBeUndefined();
  });

  it("abstains when no literal threshold exists", () => {
    const files: ProjectFile[] = [{ filePath: "src/fetch.ts", source: CLEAN }];
    const fn = candidate(CLEAN, "src/fetch.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildUnexplainedDomainThresholdEvidence(fn, files)).toBeUndefined();
  });
});
