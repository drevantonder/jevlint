import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildOutputArgumentEvidence } from "../src/evidence/output-argument.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function changedFunction(files: ProjectFile[]): ReturnType<typeof extractCandidates>[number] {
  const owner = files[0];
  expect(owner).toBeDefined();
  if (!owner) throw new Error("Fixture has no changed file.");
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find(({ kind }) => kind === "function");
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no function candidate.");
  return candidate;
}

describe("output argument evidence", () => {
  it("extracts container-filling writes, missing returns, and allocating callers", async () => {
    const files = await project("output-argument-positive", [
      "src/collect-matches.ts",
      "src/search.ts",
    ]);

    const evidence = buildOutputArgumentEvidence(changedFunction(files), files);

    expect(evidence).toMatchObject({
      function: {
        name: "collectMatches",
        parameters: ["query: string", "out: Match[]"],
      },
      outputWrites: [
        { parameter: "out", kind: "mutating-call", operation: expect.stringContaining("out.push") },
      ],
      returns: {
        hasValueReturn: false,
      },
      callers: [
        expect.objectContaining({
          filePath: "src/search.ts",
          call: expect.stringContaining("collectMatches(query, acc)"),
        }),
      ],
    });
  });

  it("abstains when the function returns its result directly", async () => {
    const files = await project("output-argument-negative", ["src/collect-matches.ts"]);

    expect(buildOutputArgumentEvidence(changedFunction(files), files)).toBeUndefined();
  });

  it("retains value returns for dual-sink accumulation", () => {
    const source = `export function collectInto(items: string[], out: string[]): string[] {
      for (const item of items) {
        out.push(item);
      }
      return out;
    }`;
    const candidate = extractCandidates("src/collect.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildOutputArgumentEvidence(
      candidate,
      [{ filePath: "src/collect.ts", source }],
    );

    expect(evidence).toMatchObject({
      outputWrites: [
        { parameter: "out", kind: "mutating-call" },
      ],
      returns: {
        hasValueReturn: true,
        valueReturns: ["return out;"],
      },
    });
  });

  it("detects Object.assign into a parameter", () => {
    const source = `export function applyPatch(target: Record<string, unknown>, patch: Record<string, unknown>): void {
      Object.assign(target, patch);
    }`;
    const candidate = extractCandidates("src/apply-patch.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildOutputArgumentEvidence(
      candidate,
      [{ filePath: "src/apply-patch.ts", source }],
    )).toMatchObject({
      outputWrites: [
        { parameter: "target", kind: "object-assign" },
      ],
    });
  });
});
