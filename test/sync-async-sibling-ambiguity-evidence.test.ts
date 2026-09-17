import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildSyncAsyncSiblingAmbiguityEvidence } from "../src/evidence/sync-async-sibling-ambiguity.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `import { readFileSync } from "node:fs";
export function load(path: string) {
  return readFileSync(path, "utf8");
}
export async function loadRemote(url: string): Promise<string> {
  const response = await fetch(url);
  return response.text();
}
`;

const consistent = `import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
export async function read(path: string): Promise<string> {
  return readFile(path, "utf8");
}
export function readSync(path: string) {
  return readFileSync(path, "utf8");
}
`;

const solo = `export function format(count: number) {
  return String(count);
}
`;

function project(source: string, filePath = "src/loader.ts", extra: ProjectFile[] = []) {
  return { files: [{ filePath, source }, ...extra], filePath };
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("sync async sibling ambiguity evidence", () => {
  it("captures an async function beside a sync same-stem sibling over disk I/O", () => {
    const { files, filePath } = project(smelly);
    const evidence = buildSyncAsyncSiblingAmbiguityEvidence(
      candidateFor(smelly, filePath, "loadRemote"),
      files,
    );

    expect(evidence).toMatchObject({
      function: { name: "loadRemote", isAsync: true },
      stem: "load",
      suffixConvention: "unsuffixed",
    });
    expect(evidence?.siblings.map(({ name }) => name)).toContain("load");
    expect(evidence?.siblings.find(({ name }) => name === "load")).toMatchObject({
      isAsync: false,
      performsSyncIo: true,
    });
  });

  it("marks a platform-convention pair as consistent", () => {
    const { files, filePath } = project(consistent);
    const evidence = buildSyncAsyncSiblingAmbiguityEvidence(
      candidateFor(consistent, filePath, "readSync"),
      files,
    );

    expect(evidence?.siblings.map(({ name }) => name)).toContain("read");
    expect(evidence?.suffixConvention).toBe("consistent");
  });

  it("abstains when no same-stem sibling exists", () => {
    const { files, filePath } = project(solo);
    expect(buildSyncAsyncSiblingAmbiguityEvidence(
      candidateFor(solo, filePath, "format"),
      files,
    )).toBeUndefined();
  });
});
