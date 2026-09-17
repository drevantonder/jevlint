import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildMisdirectingErrorMessageEvidence } from "../src/evidence/misdirecting-error-message.js";
import type { ProjectFile } from "../src/types.js";

const SMELLY = `export function loadConfig(text: string): unknown {
  const data = JSON.parse(text);
  if (!data) {
    throw new Error("network unreachable, check connection");
  }
  return data;
}
`;

const CHECKED = `export function guardResponse(status: number, ok: boolean): void {
  if (!ok) {
    throw new Error("network unreachable, status " + status);
  }
}
`;

const CLEAN = `export function fail(): never {
  throw new Error("operation failed");
}
`;

function candidate(source: string, filePath: string) {
  return extractCandidates(filePath, source).find(({ kind }) => kind === "function");
}

describe("misdirecting error message evidence", () => {
  it("reports a network cause the throwing code never checks", () => {
    const files: ProjectFile[] = [{ filePath: "src/config.ts", source: SMELLY }];
    const fn = candidate(SMELLY, "src/config.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    const evidence = buildMisdirectingErrorMessageEvidence(fn, files);

    expect(evidence).toMatchObject({
      throws: [
        expect.objectContaining({
          namedCause: "network",
          insideCatch: false,
          causeCheckedInScope: false,
          hasCauseLinkage: false,
        }),
      ],
    });
  });

  it("marks the cause checked when the scope tests the boundary", () => {
    const files: ProjectFile[] = [{ filePath: "src/fetch.ts", source: CHECKED }];
    const fn = candidate(CHECKED, "src/fetch.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    const evidence = buildMisdirectingErrorMessageEvidence(fn, files);

    expect(evidence).toMatchObject({
      throws: [expect.objectContaining({ namedCause: "network", causeCheckedInScope: true })],
    });
  });

  it("abstains when no message asserts a specific cause", () => {
    const files: ProjectFile[] = [{ filePath: "src/fail.ts", source: CLEAN }];
    const fn = candidate(CLEAN, "src/fail.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildMisdirectingErrorMessageEvidence(fn, files)).toBeUndefined();
  });
});
