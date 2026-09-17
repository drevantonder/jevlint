import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUncheckedPreconditionEvidence } from "../src/evidence/unchecked-precondition.js";
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

describe("unchecked precondition evidence", () => {
  it("extracts an unguarded index access and the violating caller", async () => {
    const files = await project("unchecked-precondition-positive", [
      "src/first-item.ts",
      "src/use-items.ts",
    ]);

    const evidence = buildUncheckedPreconditionEvidence(changedFunction(files), files);

    expect(evidence).toMatchObject({
      function: {
        name: "firstItemId",
        parameters: ["items"],
      },
      assumptions: [
        { parameter: "items", kind: "index-access", operation: "items[0]", guarded: false },
      ],
      guards: [],
      repository: {
        callers: [
          expect.objectContaining({
            filePath: "src/use-items.ts",
            call: "firstItemId([])",
          }),
        ],
      },
    });
  });

  it("marks the assumption guarded beside an assertion", async () => {
    const files = await project("unchecked-precondition-negative", ["src/first-item.ts"]);

    const evidence = buildUncheckedPreconditionEvidence(changedFunction(files), files);

    expect(evidence?.assumptions).toEqual([
      expect.objectContaining({ parameter: "items", kind: "index-access", guarded: true }),
    ]);
    expect(evidence?.guards).toEqual([
      expect.stringContaining("assert(items.length > 0"),
    ]);
  });

  it("abstains when the function assumes nothing shaped", () => {
    const source = `export function add(left: number, right: number): number {
      return left + right;
    }`;
    const candidate = extractCandidates("src/add.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUncheckedPreconditionEvidence(
      candidate,
      [{ filePath: "src/add.ts", source }],
    )).toBeUndefined();
  });

  it("detects division by a parameter and key access without a presence check", () => {
    const source = `export function share(total: number, parts: number): number {
      return total / parts;
    }
    export function lookup(table: Record<string, number>, key: string): number {
      return table[key];
    }`;
    const candidates = extractCandidates("src/share.ts", source);
    const share = candidates.find(({ source: text }) => text.includes("total / parts"));
    const lookup = candidates.find(({ source: text }) => text.includes("table[key]"));
    expect(share).toBeDefined();
    expect(lookup).toBeDefined();
    if (!share || !lookup) return;
    const files: ProjectFile[] = [{ filePath: "src/share.ts", source }];

    expect(buildUncheckedPreconditionEvidence(share, files)?.assumptions).toEqual([
      expect.objectContaining({ parameter: "parts", kind: "division", guarded: false }),
    ]);
    expect(buildUncheckedPreconditionEvidence(lookup, files)?.assumptions).toEqual([
      expect.objectContaining({ parameter: "table", kind: "key-access", guarded: false }),
    ]);
  });
});
