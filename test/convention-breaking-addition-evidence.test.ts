import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildConventionBreakingAdditionEvidence } from "../src/evidence/convention-breaking-addition.js";

const moduleSource = `
  import { readConfig } from "./config";
  export async function loadFirst(path: string): Promise<string> {
    const config = await readConfig(path);
    if (!config) throw new Error("missing config");
    return config.name;
  }
  export async function loadSecond(path: string): Promise<string> {
    const config = await readConfig(path);
    if (!config) throw new Error("missing config");
    return config.label;
  }
  export function loadThird(path: string): Promise<string> {
    return readConfig(path).then((config) => {
      if (!config) return null;
      return config.name;
    });
  }
`;

function candidateFor(snippet: string) {
  const candidate = extractCandidates("src/loader.ts", moduleSource)
    .find(({ kind, source }) => kind === "function" && source.includes(snippet));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("candidate missing");
  return candidate;
}

describe("convention breaking addition evidence", () => {
  it("flags async and error-signaling drift against the module norm", () => {
    const candidate = candidateFor("function loadThird");

    expect(buildConventionBreakingAdditionEvidence(
      candidate,
      [{ filePath: "src/loader.ts", source: moduleSource }],
    )).toMatchObject({
      function: { name: "loadThird", exported: true },
      divergences: expect.arrayContaining([
        expect.objectContaining({ signal: "async-style", moduleNorm: "await" }),
        expect.objectContaining({ signal: "error-signaling", moduleNorm: "throw" }),
      ]),
    });
  });

  it("returns agreeing signals with no divergences for a conforming function", () => {
    const candidate = candidateFor("function loadFirst");

    expect(buildConventionBreakingAdditionEvidence(
      candidate,
      [{ filePath: "src/loader.ts", source: moduleSource }],
    )).toMatchObject({
      function: { name: "loadFirst" },
      divergences: [],
    });
  });

  it("abstains when the candidate carries no convention signals", () => {
    const source = `
      export function identity(value: number): number {
        return value;
      }
    `;
    const candidate = extractCandidates("src/identity.ts", source)[0];
    if (!candidate) return;

    expect(buildConventionBreakingAdditionEvidence(
      candidate,
      [{ filePath: "src/identity.ts", source }],
    )).toBeUndefined();
  });
});
