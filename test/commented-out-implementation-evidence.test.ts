import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildCommentedOutImplementationEvidence } from "../src/evidence/commented-out-implementation.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function commentCandidate(source: string, filePath: string, snippet: string): Candidate {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "comment" && text.includes(snippet));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("missing candidate");
  return candidate;
}

describe("commented out implementation evidence", () => {
  it("reports parseable statements with unresolved identifiers", async () => {
    const projectFiles = await project("commented-out-smelly", ["src/pricing.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;

    const evidence = buildCommentedOutImplementationEvidence(
      commentCandidate(owner.source, owner.filePath, "oldPriceLabel"),
      projectFiles,
    );

    expect(evidence).toMatchObject({
      comment: { filePath: "src/pricing.ts" },
      codeSignals: {
        parseable: true,
        needsFunctionWrap: false,
        balancedBraces: true,
        hasCall: true,
      },
      staleness: {
        unresolved: expect.arrayContaining(["oldPriceLabel", "dollars", "rest"]),
      },
    });
    expect(evidence?.codeSignals.keywords).toEqual(
      expect.arrayContaining(["function", "const", "return"]),
    );
  });

  it("emits one judgment per block: later lines abstain", async () => {
    const projectFiles = await project("commented-out-smelly", ["src/pricing.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;

    const later = extractCandidates(owner.filePath, owner.source)
      .find(({ kind, source: text }) => kind === "comment" && text.includes("const dollars"));
    expect(later).toBeDefined();
    if (!later) return;

    expect(buildCommentedOutImplementationEvidence(later, projectFiles)).toBeUndefined();
  });

  it("abstains for prose documentation", async () => {
    const projectFiles = await project("commented-out-smelly", ["src/pricing.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;

    expect(buildCommentedOutImplementationEvidence(
      commentCandidate(owner.source, owner.filePath, "Keep this helper"),
      projectFiles,
    )).toBeUndefined();
  });

  it("detects an adjacent live duplicate sharing identifiers", () => {
    const source = "export function total(items: number[]): number {\n"
      + "  return items.reduce((sum, item) => sum + item, 0);\n"
      + "}\n"
      + "// const total = items.reduce((sum, item) => sum + item, 0);\n"
      + "// return total;\n";
    const candidate = commentCandidate(source, "src/totals.ts", "const total");
    const projectFiles: ProjectFile[] = [{ filePath: "src/totals.ts", source }];

    const evidence = buildCommentedOutImplementationEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      codeSignals: { parseable: true, needsFunctionWrap: true },
      liveDuplicate: {
        functionName: "total",
        sharedIdentifiers: expect.arrayContaining(["items", "reduce", "sum", "item"]),
      },
    });
  });

  it("abstains for a single-line fragment with no code shape", () => {
    const source = "// fixed\n"
      + "export function total(items: number[]): number {\n"
      + "  return items.length;\n"
      + "}\n";
    const candidate = commentCandidate(source, "src/totals.ts", "fixed");

    expect(buildCommentedOutImplementationEvidence(candidate, [{ filePath: "src/totals.ts", source }]))
      .toBeUndefined();
  });

  it("abstains for non-comment candidates", () => {
    const source = "export function total(items: number[]): number {\n"
      + "  return items.length;\n"
      + "}\n";
    const candidate = extractCandidates("src/totals.ts", source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildCommentedOutImplementationEvidence(candidate, [{ filePath: "src/totals.ts", source }]))
      .toBeUndefined();
  });
});
