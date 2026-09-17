import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildContractSignatureDriftEvidence } from "../src/evidence/contract-signature-drift.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

describe("contract signature drift evidence", () => {
  it("extracts override arity drift against the base contract", async () => {
    const projectFiles = await project("contract-drift-positive", [
      "src/calendar.ts",
      "src/booking.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("return event.title"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildContractSignatureDriftEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      drifts: [{
        kind: "override-arity",
        detail: expect.stringContaining("credentialId"),
      }],
      contractModule: expect.objectContaining({ filePath: "src/calendar.ts" }),
    });
  });

  it("abstains when an override adds only an optional parameter", async () => {
    const projectFiles = await project("contract-drift-negative", [
      "src/calendar.ts",
      "src/booking.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("dryRun"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildContractSignatureDriftEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("flags short calls against same-module required parameters", () => {
    const source = `
      export function publish(title: string, channel: string): void {
        console.log(title, channel);
      }

      export function announce(title: string): void {
        publish(title);
      }
    `;
    const candidate = extractCandidates("src/publish.ts", source)
      .find(({ source }) => source.includes("function announce"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildContractSignatureDriftEvidence(
      candidate,
      [{ filePath: "src/publish.ts", source }],
    )).toMatchObject({
      drifts: [{ kind: "arity-shortfall", detail: expect.stringContaining("publish") }],
    });
  });

  it("flags null returns against a non-nullable contract", () => {
    const source = `
      export function countMembers(members: string[]): number {
        if (members.length === 0) return null;
        return members.length;
      }
    `;
    const candidate = extractCandidates("src/count.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildContractSignatureDriftEvidence(
      candidate,
      [{ filePath: "src/count.ts", source }],
    )).toMatchObject({
      drifts: [{ kind: "nullable-return", detail: expect.stringContaining("number") }],
    });
  });
});
