import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnsynchronizedSharedMemoryEvidence } from "../src/evidence/unsynchronized-shared-memory.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `import { Worker } from "node:worker_threads";
const buffer = new SharedArrayBuffer(4);
const view = new Int32Array(buffer);
export function bump() {
  view[0] += 1;
  const worker = new Worker("./worker.js");
  worker.postMessage(buffer);
  return view[0];
}
`;

const guarded = `import { Worker } from "node:worker_threads";
const buffer = new SharedArrayBuffer(4);
const view = new Int32Array(buffer);
export function bump() {
  Atomics.add(view, 0, 1);
  const worker = new Worker("./worker.js");
  worker.postMessage(buffer);
  return Atomics.load(view, 0);
}
`;

const readOnly = `const buffer = new SharedArrayBuffer(4);
const view = new Int32Array(buffer);
export function readSlot() {
  return view[0];
}
`;

function project(source: string, filePath = "src/counter.ts", extra: ProjectFile[] = []) {
  return { files: [{ filePath, source }, ...extra], filePath };
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("unsynchronized shared memory evidence", () => {
  it("captures a plain indexed write on a worker-shared buffer", () => {
    const { files, filePath } = project(smelly);
    const evidence = buildUnsynchronizedSharedMemoryEvidence(candidateFor(smelly, filePath, "view[0] +="), files);

    expect(evidence).toMatchObject({
      function: { name: "bump", exported: true },
      atomics: { present: false },
      workerSharing: { present: true },
    });
    expect(evidence?.sharedBuffers).toHaveLength(1);
    expect(evidence?.views).toHaveLength(1);
    expect(evidence?.accesses).toContainEqual({ source: "view[0] += 1", view: "view", write: true, line: 5 });
  });

  it("records Atomics coordination as weakening evidence", () => {
    const { files, filePath } = project(guarded);
    const evidence = buildUnsynchronizedSharedMemoryEvidence(candidateFor(guarded, filePath, "Atomics.add"), files);

    expect(evidence?.atomics.present).toBe(true);
    expect(evidence?.atomics.calls).toHaveLength(2);
    expect(evidence?.accesses.filter(({ write }) => write)).toEqual([]);
  });

  it("captures read-only use after setup", () => {
    const { files, filePath } = project(readOnly);
    const evidence = buildUnsynchronizedSharedMemoryEvidence(candidateFor(readOnly, filePath, "return view[0]"), files);

    expect(evidence?.accesses).toMatchObject([{ view: "view", write: false }]);
    expect(evidence?.workerSharing.present).toBe(false);
  });

  it("abstains for a plain local typed array with no sharing", () => {
    const source = `export function total(bytes: number[]) {
  const view = new Uint8Array(bytes);
  return view[0] + view[1];
}
`;
    const { files, filePath } = project(source);
    expect(buildUnsynchronizedSharedMemoryEvidence(candidateFor(source, filePath, "view[0] + view[1]"), files))
      .toBeUndefined();
  });

  it("abstains for ordinary single-thread state", () => {
    const source = `export function total(items: number[]) {
  return items.reduce((sum, item) => sum + item, 0);
}
`;
    const { files, filePath } = project(source);
    expect(buildUnsynchronizedSharedMemoryEvidence(candidateFor(source, filePath, "reduce"), files))
      .toBeUndefined();
  });
});
