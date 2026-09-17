import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildHandRolledUrlQueryEvidence } from "../src/evidence/hand-rolled-url-query.js";
import { buildUnvalidatedBoundaryEvidence } from "../src/evidence/unvalidated-boundary-shape.js";
import type { ProjectFile } from "../src/types.js";

const SMELLY_PARSE = `export function parseQuery(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pairs = text.split("&");
  for (const pair of pairs) {
    const parts = pair.split("=");
    result[decodeURIComponent(parts[0] ?? "")] = decodeURIComponent(parts[1] ?? "");
  }
  return result;
}
`;

const SMELLY_BUILD = `export function buildQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => encodeURIComponent(key) + "=" + encodeURIComponent(value))
    .join("&");
}
`;

const NESTED = `export function parseNested(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of text.split("&")) {
    const parts = pair.split("=");
    const key = decodeURIComponent(parts[0] ?? "");
    if (key.includes("[a]")) result["nested"] = decodeURIComponent(parts[1] ?? "");
  }
  return result;
}
`;

const PLATFORM = `export function getParam(url: string, key: string): string | null {
  return new URL(url).searchParams.get(key);
}
`;

function candidateFor(source: string, marker: string) {
  const filePath = "src/query.ts";
  const projectFiles: ProjectFile[] = [{ filePath, source }];
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return { candidate: candidate!, projectFiles };
}

describe("hand-rolled url query evidence", () => {
  it("reports split-based parsing with decoding", () => {
    const { candidate, projectFiles } = candidateFor(SMELLY_PARSE, "parseQuery");

    const evidence = buildHandRolledUrlQueryEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "parseQuery" },
      parseSignals: expect.arrayContaining([expect.stringContaining("split")]),
      nestedSyntaxSupport: false,
      usesUrlSearchParams: false,
    });
  });

  it("reports encode-join building", () => {
    const { candidate, projectFiles } = candidateFor(SMELLY_BUILD, "buildQuery");

    const evidence = buildHandRolledUrlQueryEvidence(candidate, projectFiles);

    expect(evidence?.buildSignals.length).toBeGreaterThan(0);
  });

  it("carries nested-shape support as justification-side evidence", () => {
    const { candidate, projectFiles } = candidateFor(NESTED, "parseNested");

    const evidence = buildHandRolledUrlQueryEvidence(candidate, projectFiles);

    expect(evidence?.nestedSyntaxSupport).toBe(true);
  });

  it("abstains on platform URLSearchParams access", () => {
    const { candidate, projectFiles } = candidateFor(PLATFORM, "getParam");

    expect(buildHandRolledUrlQueryEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("scores machinery where boundary validation stays silent", () => {
    const { candidate, projectFiles } = candidateFor(SMELLY_PARSE, "parseQuery");

    expect(buildHandRolledUrlQueryEvidence(candidate, projectFiles)).toBeDefined();
    expect(buildUnvalidatedBoundaryEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
