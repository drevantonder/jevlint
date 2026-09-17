import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDetachedAsyncWorkEvidence } from "../src/evidence/detached-async-work.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("detached async work evidence", () => {
  it("flags a bare statement call to an imported async function", async () => {
    const projectFiles = await project("detached-async-positive", [
      "src/handler.ts",
      "src/mailer.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function handleSignup"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildDetachedAsyncWorkEvidence(candidate, projectFiles)).toMatchObject({
      function: { name: "handleSignup", async: false, exported: true },
      detached: [{
        expression: "sendReceipt(email)",
        callee: "sendReceipt",
        kind: "bare-statement",
        asyncness: "confirmed",
        asyncnessReason: expect.stringContaining("imported async function"),
        importedFrom: "./mailer.js",
      }],
      enclosingMayReturnPromise: false,
      moduleHasRejectionGuard: false,
    });
  });

  it("keeps the rejection guard visible while still reporting the bare call", async () => {
    const projectFiles = await project("detached-async-exception", [
      "src/handler.ts",
      "src/tasks.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function handleTick"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildDetachedAsyncWorkEvidence(candidate, projectFiles)).toMatchObject({
      detached: [{ callee: "runJob", kind: "bare-statement", asyncness: "confirmed" }],
      moduleHasRejectionGuard: true,
    });
  });

  it("abstains when the promise is awaited", async () => {
    const projectFiles = await project("detached-async-negative", [
      "src/handler.ts",
      "src/mailer.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("function handleSignup"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildDetachedAsyncWorkEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when the promise is stored and later awaited", () => {
    const source = `
      import { sendReceipt } from "./mailer.js";
      export async function handleSignup(email: string) {
        const pending = sendReceipt(email);
        await pending;
      }
    `;
    const candidate = extractCandidates("src/handler.ts", source)
      .find(({ source: text }) => text.includes("function handleSignup"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildDetachedAsyncWorkEvidence(
      candidate,
      [
        { filePath: "src/handler.ts", source },
        { filePath: "src/mailer.ts", source: "export async function sendReceipt(e: string) {}" },
      ],
    )).toBeUndefined();
  });
});
