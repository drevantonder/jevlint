import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildQuerySideEffectEvidence } from "../src/evidence/query-side-effect.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function changedFunction(files: ProjectFile[]) {
  const owner = files[0];
  expect(owner).toBeDefined();
  if (!owner) throw new Error("Fixture has no changed file.");
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find(({ kind }) => kind === "function");
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no function candidate.");
  return candidate;
}

describe("query side-effect evidence", () => {
  it("shows Jev returned values, ignored commands, targets, and callers", async () => {
    const files = await project("query-side-effect-positive", [
      "src/get-next-available-seat.ts",
      "src/seat-store.ts",
      "src/show-seat.ts",
    ]);

    const evidence = buildQuerySideEffectEvidence(changedFunction(files), files);

    expect(evidence).toMatchObject({
      function: { name: "getNextAvailableSeat" },
      returns: [
        { expression: "null" },
        { expression: "seat" },
      ],
      sideEffects: [
        {
          kind: "ignored-call",
          operation: "reserveSeat(flightId, seat.id)",
          target: {
            root: "reserveSeat",
            importedFrom: "./seat-store.js",
            ownership: "project-module",
            targetModule: {
              filePath: "src/seat-store.ts",
              source: expect.stringContaining("seat.reserved = true"),
            },
          },
        },
      ],
      callers: [expect.objectContaining({ call: "getNextAvailableSeat(flightId)" })],
    });
  });

  it("abstains for a pure value-returning query", async () => {
    const files = await project("query-side-effect-negative", ["src/get-next-available-seat.ts"]);

    expect(buildQuerySideEffectEvidence(changedFunction(files), files)).toBeUndefined();
  });

  it.each([
    ["query-side-effect-exception", ["src/get-user.ts", "src/metrics.ts"], "metrics.increment(\"user_lookup\")"],
    ["query-side-effect-ambiguous", ["src/check-invitation.ts"], "touchInvitation(invitation.id)"],
  ])("retains semantic evidence for %s", async (name, paths, operation) => {
    const files = await project(name, paths);

    expect(buildQuerySideEffectEvidence(changedFunction(files), files)?.sideEffects)
      .toEqual([expect.objectContaining({ operation })]);
  });

  it("does not mistake mutation of a parameter for an external command", () => {
    const source = `export function normalize(profile: Profile): Profile {
      profile.email = profile.email.trim();
      return profile;
    }`;
    const candidate = extractCandidates("src/normalize.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildQuerySideEffectEvidence(candidate, [{ filePath: "src/normalize.ts", source }]))
      .toBeUndefined();
  });
});
