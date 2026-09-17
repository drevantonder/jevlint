import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildPhantomMemberAccessEvidence } from "../src/evidence/phantom-member-access.js";
import type { ProjectFile } from "../src/types.js";

const ownerSource = `
  export function recordStorageDuration(ms: number): void {}
  export function recordMemoryUsage(mb: number): void {}
`;

const consumerSource = `
  import * as storage from "./storage";
  export function trackStorage(ms: number): void {
    storage.recordStorageDuration(ms);
  }
  export function trackEmbedding(input: string): void {
    storage.createEmbedding(input);
  }
`;

function project(): ProjectFile[] {
  return [
    { filePath: "src/storage.ts", source: ownerSource },
    { filePath: "src/tracking.ts", source: consumerSource },
  ];
}

function candidateFor(source: string, snippet: string) {
  const candidate = extractCandidates("src/tracking.ts", source)
    .find(({ source: text }) => text.includes(snippet));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("candidate missing");
  return candidate;
}

describe("phantom member access evidence", () => {
  it("flags a member missing from the owner surface", () => {
    const candidate = candidateFor(consumerSource, "function trackEmbedding");

    expect(buildPhantomMemberAccessEvidence(candidate, project())).toMatchObject({
      function: { name: "trackEmbedding", exported: true },
      accesses: [{
        path: "storage.createEmbedding",
        root: "storage",
        importedFrom: "./storage",
        ownerFile: "src/storage.ts",
        memberFound: false,
      }],
    });
  });

  it("marks a member the owner defines as found", () => {
    const candidate = candidateFor(consumerSource, "function trackStorage");

    expect(buildPhantomMemberAccessEvidence(candidate, project())).toMatchObject({
      accesses: [{
        path: "storage.recordStorageDuration",
        memberFound: true,
      }],
    });
  });

  it("abstains when no member access roots at an import", () => {
    const source = `
      export function total(values: number[]): number {
        return values.reduce((sum, value) => sum + value, 0);
      }
    `;
    const candidate = extractCandidates("src/total.ts", source)[0];
    if (!candidate) return;

    expect(buildPhantomMemberAccessEvidence(
      candidate,
      [{ filePath: "src/total.ts", source }],
    )).toBeUndefined();
  });
});
