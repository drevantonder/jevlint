import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildBlockingEventLoopCallEvidence } from "../src/evidence/blocking-event-loop-call.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `import { readFileSync } from "node:fs";
export function handleRequest(req: { path: string }) {
  const body = readFileSync(req.path, "utf8");
  return body.length;
}
`;

const scripted = `import { readFileSync } from "node:fs";
export function buildSite(entry: string) {
  return readFileSync(entry, "utf8");
}
`;

const clean = `import { readFile } from "node:fs/promises";
export async function handleRequest(req: { path: string }) {
  const body = await readFile(req.path, "utf8");
  return body.length;
}
`;

function project(source: string, filePath = "src/handler.ts", extra: ProjectFile[] = []) {
  return { files: [{ filePath, source }, ...extra], filePath };
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("blocking event loop call evidence", () => {
  it("captures a sync read inside a handler-shaped function", () => {
    const { files, filePath } = project(smelly);
    const evidence = buildBlockingEventLoopCallEvidence(candidateFor(smelly, filePath, "handleRequest"), files);

    expect(evidence).toMatchObject({
      function: { name: "handleRequest", exported: true },
      blockingCalls: [{ callee: "readFileSync", kind: "sync-call" }],
    });
    expect(evidence?.servingContext.handlerHints).toContain("handleRequest");
    expect(evidence?.mitigation.workerImport).toBe(false);
  });

  it("captures execSync and JSON.parse sinks", () => {
    const source = `import { execSync } from "node:child_process";
export function handleWebhook(payload: string) {
  const data = JSON.parse(payload);
  return execSync("process " + data.id).toString();
}
`;
    const { files, filePath } = project(source);
    const evidence = buildBlockingEventLoopCallEvidence(candidateFor(source, filePath, "handleWebhook"), files);

    expect(evidence?.blockingCalls.map(({ kind }) => kind).sort()).toEqual(["serialization", "sync-call"]);
    expect(evidence?.blockingCalls.map(({ callee }) => callee)).toContain("execSync");
  });

  it("notes script context as weakening evidence while still reporting", () => {
    const { files } = project(scripted, "scripts/build.ts");
    const evidence = buildBlockingEventLoopCallEvidence(
      candidateFor(scripted, "scripts/build.ts", "buildSite"),
      files,
    );

    expect(evidence?.blockingCalls).toMatchObject([{ callee: "readFileSync" }]);
    expect(evidence?.servingContext.scriptHints).toContain("scripts/build.ts");
  });

  it("abstains when only the async variant is used", () => {
    const { files, filePath } = project(clean);
    expect(buildBlockingEventLoopCallEvidence(candidateFor(clean, filePath, "handleRequest"), files))
      .toBeUndefined();
  });

  it("abstains for pure computation with no sink", () => {
    const source = `export function total(items: number[]) {
      return items.reduce((sum, item) => sum + item, 0);
    }`;
    const { files, filePath } = project(source);
    expect(buildBlockingEventLoopCallEvidence(candidateFor(source, filePath, "total"), files))
      .toBeUndefined();
  });

  it("includes repository callers for serving reach", () => {
    const { files, filePath } = project(smelly, "src/handler.ts", [{
      filePath: "src/server.ts",
      source: `import { handleRequest } from "./handler";\nserver.on("request", (req) => handleRequest(req));`,
    }]);
    const evidence = buildBlockingEventLoopCallEvidence(candidateFor(smelly, filePath, "handleRequest"), files);
    expect(evidence?.repository.callers).toMatchObject([{ filePath: "src/server.ts" }]);
  });
});
