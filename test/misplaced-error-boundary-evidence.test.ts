import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildMisplacedErrorBoundaryEvidence } from "../src/evidence/misplaced-error-boundary.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const misplaced = `export async function loadConfig() {
  let cached: unknown;
  try {
    cached = cache.get("config");
  } catch (error) {
    cached = {};
  }
  const config = await fetchConfig();
  return { cached, config };
}
`;

const placed = `export async function loadConfig() {
  const config = await fetchConfig();
  let parsed: unknown;
  try {
    parsed = JSON.parse(config);
  } catch (error) {
    throw new Error("invalid config", { cause: error });
  }
  return parsed;
}
`;

const plain = `export async function loadConfig() {
  return fetchConfig();
}
`;

function candidateFor(source: string, filePath: string, snippet: string): Candidate {
  const found = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(snippet));
  expect(found).toBeDefined();
  expect(found?.kind).toBe("function");
  if (!found) throw new Error("candidate missing");
  return found;
}

describe("misplaced error boundary evidence", () => {
  it("pairs the guarded infallible read with the uncovered fallible neighbor", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/config.ts", source: misplaced }];
    const candidate = candidateFor(misplaced, "src/config.ts", "function loadConfig");

    const evidence = buildMisplacedErrorBoundaryEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "loadConfig", exported: true },
      boundaries: [{
        inSpanCalls: [expect.stringContaining("cache.get")],
        uncoveredNeighbors: [expect.stringContaining("fetchConfig")],
      }],
    });
  });

  it("keeps covered fallible spans visible so the judgment can score low", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/config.ts", source: placed }];
    const candidate = candidateFor(placed, "src/config.ts", "function loadConfig");

    const evidence = buildMisplacedErrorBoundaryEvidence(candidate, projectFiles);

    expect(evidence?.boundaries[0]?.inSpanCalls).toEqual([
      expect.stringContaining("JSON.parse"),
    ]);
    expect(evidence?.boundaries[0]?.uncoveredNeighbors).toEqual([]);
  });

  it("abstains when the function has no error boundary", () => {
    const candidate = candidateFor(plain, "src/config.ts", "function loadConfig");

    expect(buildMisplacedErrorBoundaryEvidence(candidate, [{ filePath: "src/config.ts", source: plain }]))
      .toBeUndefined();
  });

  it("abstains for non-function candidates", () => {
    const comment = { ...candidateFor(misplaced, "src/config.ts", "function loadConfig"), kind: "comment" as const };
    expect(buildMisplacedErrorBoundaryEvidence(comment, [{ filePath: "src/config.ts", source: misplaced }]))
      .toBeUndefined();
  });

  it("dispatches through the rule registry", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/config.ts", source: misplaced }];
    const candidate = candidateFor(misplaced, "src/config.ts", "function loadConfig");

    const result = buildRuleEvidence("jev/no-misplaced-error-boundary", candidate, projectFiles);

    expect(result.handled).toBe(true);
    expect(result.handled && result.evidence).toBeDefined();
  });
});
