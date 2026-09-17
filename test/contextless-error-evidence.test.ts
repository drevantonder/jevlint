import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildContextlessErrorEvidence } from "../src/evidence/contextless-error.js";
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

describe("contextless error evidence", () => {
  it("extracts a static-literal rethrow that drops the caught error, plus callers", async () => {
    const files = await project("contextless-error-positive", [
      "src/save-record.ts",
      "src/store.ts",
      "src/service.ts",
    ]);

    const evidence = buildContextlessErrorEvidence(changedFunction(files), files);

    expect(evidence).toMatchObject({
      function: {
        name: "saveRecord",
      },
      thrownErrors: [
        {
          operation: 'throw new Error("save failed");',
          thrownType: "Error",
          kind: "static-literal",
          hasMessageArgument: true,
          hasInterpolation: false,
          hasCause: false,
          referencesCaughtError: false,
        },
      ],
      emptyRejections: [],
      repository: {
        callers: [
          expect.objectContaining({ filePath: "src/service.ts" }),
        ],
      },
    });
  });

  it("marks cause-linked interpolation as context-carrying", async () => {
    const files = await project("contextless-error-negative", [
      "src/save-record.ts",
      "src/store.ts",
    ]);

    const evidence = buildContextlessErrorEvidence(changedFunction(files), files);

    expect(evidence?.thrownErrors).toEqual([
      expect.objectContaining({
        kind: "context-carrying",
        hasInterpolation: true,
        hasCause: true,
      }),
    ]);
  });

  it("abstains when the function raises nothing", () => {
    const source = `export function add(left: number, right: number): number {
      return left + right;
    }`;
    const candidate = extractCandidates("src/add.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildContextlessErrorEvidence(
      candidate,
      [{ filePath: "src/add.ts", source }],
    )).toBeUndefined();
  });

  it("detects empty Promise rejections and bare rethrows", () => {
    const source = `export function load(key: string): Promise<string> {
      try {
        return Promise.resolve(key);
      } catch (err) {
        throw err;
      }
    }
    export function fail(): Promise<string> {
      return Promise.reject();
    }`;
    const candidates = extractCandidates("src/load.ts", source);
    const load = candidates.find(({ source: text }) => text.includes("throw err"));
    const fail = candidates.find(({ source: text }) => text.includes("Promise.reject"));
    expect(load).toBeDefined();
    expect(fail).toBeDefined();
    if (!load || !fail) return;
    const files: ProjectFile[] = [{ filePath: "src/load.ts", source }];

    expect(buildContextlessErrorEvidence(load, files)?.thrownErrors).toEqual([
      expect.objectContaining({ kind: "bare-rethrow" }),
    ]);
    expect(buildContextlessErrorEvidence(fail, files)?.emptyRejections).toEqual([
      { operation: "Promise.reject()" },
    ]);
  });
});
