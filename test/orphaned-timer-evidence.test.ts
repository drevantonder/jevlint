import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildOrphanedTimerEvidence } from "../src/evidence/orphaned-timer.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `export function handleConnection(socket: { on: (event: string, cb: () => void) => void }) {
  const heartbeat = setInterval(() => socket.on("ping", () => {}), 30_000);
  return heartbeat;
}
export function finishConnection() {
  return true;
}
`;

const cleaned = `let heartbeat: ReturnType<typeof setInterval> | undefined;
export function handleConnection(socket: { on: (event: string, cb: () => void) => void }) {
  heartbeat = setInterval(() => socket.on("ping", () => {}), 30_000);
  return heartbeat;
}
export function closeConnection() {
  if (heartbeat) clearInterval(heartbeat);
}
`;

function project(source: string, filePath = "src/socket.ts", extra: ProjectFile[] = []) {
  return { files: [{ filePath, source }, ...extra], filePath };
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("orphaned timer evidence", () => {
  it("captures a repeating timer with no teardown release", () => {
    const { files, filePath } = project(smelly);
    const evidence = buildOrphanedTimerEvidence(candidateFor(smelly, filePath, "handleConnection"), files);

    expect(evidence).toMatchObject({
      function: { name: "handleConnection", exported: true },
      timers: [{ kind: "setInterval", repeating: true, storedAs: "heartbeat", cleared: false }],
      teardown: { present: false, clearsTimer: false },
    });
    expect(evidence?.moduleReleases).toEqual([]);
  });

  it("records the clear call when a teardown releases the handle", () => {
    const { files, filePath } = project(cleaned);
    const evidence = buildOrphanedTimerEvidence(candidateFor(cleaned, filePath, "heartbeat = setInterval"), files);

    expect(evidence?.timers).toMatchObject([{ storedAs: "heartbeat", cleared: true }]);
    expect(evidence?.timers[0]?.clearEvidence).toContain("clearInterval");
    expect(evidence?.teardown).toMatchObject({ present: true, clearsTimer: true });
    expect(evidence?.moduleReleases).toContain("clearInterval");
  });

  it("captures a one-shot timeout as non-repeating", () => {
    const source = `export function scheduleRetry(task: () => void) {
  setTimeout(task, 1000);
}
`;
    const { files, filePath } = project(source);
    const evidence = buildOrphanedTimerEvidence(candidateFor(source, filePath, "scheduleRetry"), files);

    expect(evidence?.timers).toMatchObject([{ kind: "setTimeout", repeating: false, storedAs: null }]);
  });

  it("abstains when no timer is created", () => {
    const source = `export function handleConnection(socket: { id: string }) {
  return socket.id;
}
`;
    const { files, filePath } = project(source);
    expect(buildOrphanedTimerEvidence(candidateFor(source, filePath, "handleConnection"), files))
      .toBeUndefined();
  });

  it("abstains for immediate async work with no schedule", () => {
    const source = `export async function handleConnection(socket: { id: string }) {
  await Promise.resolve(socket.id);
}
`;
    const { files, filePath } = project(source);
    expect(buildOrphanedTimerEvidence(candidateFor(source, filePath, "handleConnection"), files))
      .toBeUndefined();
  });

  it("includes callers for repeated-creation sensitivity", () => {
    const { files, filePath } = project(smelly, "src/socket.ts", [{
      filePath: "src/server.ts",
      source: `import { handleConnection } from "./socket";\nexport function onSocket(s: never) { handleConnection(s); }`,
    }]);
    const evidence = buildOrphanedTimerEvidence(candidateFor(smelly, filePath, "handleConnection"), files);
    expect(evidence?.callers).toMatchObject([{ filePath: "src/server.ts" }]);
  });
});
