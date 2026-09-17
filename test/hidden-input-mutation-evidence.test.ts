import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildHiddenInputMutationEvidence } from "../src/evidence/hidden-input-mutation.js";
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

describe("hidden input mutation evidence", () => {
  it("extracts caller-owned mutations and repository callers", async () => {
    const files = await project("hidden-input-mutation-positive", [
      "src/normalize-profile.ts",
      "src/update-profile.ts",
    ]);

    const evidence = buildHiddenInputMutationEvidence(changedFunction(files), files);

    expect(evidence).toMatchObject({
      function: {
        name: "normalizeProfile",
        parameters: ["profile: Profile"],
      },
      mutations: [
        { parameter: "profile", kind: "assignment", operation: "profile.email = profile.email.trim().toLowerCase()" },
        { parameter: "profile", kind: "mutating-call", operation: "profile.tags.sort()" },
        { parameter: "profile", kind: "update", operation: "profile.normalizationCount += 1" },
      ],
      callers: [
        expect.objectContaining({
          filePath: "src/update-profile.ts",
          call: "normalizeProfile(profile)",
        }),
      ],
    });
  });

  it("abstains when a transformation returns a copy", async () => {
    const files = await project("hidden-input-mutation-negative", ["src/normalize-profile.ts"]);

    expect(buildHiddenInputMutationEvidence(changedFunction(files), files)).toBeUndefined();
  });

  it.each([
    ["hidden-input-mutation-exception", "src/append-audit-event.ts", "events.push(event)"],
    ["hidden-input-mutation-ambiguous", "src/apply-patch.ts", "Object.assign(target, patch)"],
  ])("retains semantic evidence for %s", async (name, filePath, operation) => {
    const files = await project(name, [filePath]);

    const evidence = buildHiddenInputMutationEvidence(changedFunction(files), files);

    expect(evidence?.mutations).toEqual([
      expect.objectContaining({ operation }),
    ]);
  });

  it("does not attribute a nested callback's parameter mutation to its owner", () => {
    const source = `export function mapProfiles(profiles: Profile[]) {
      return incoming.map((profile) => {
        profiles.push(profile);
        return profile;
      });
    }`;
    const candidate = extractCandidates("src/map-profiles.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildHiddenInputMutationEvidence(
      candidate,
      [{ filePath: "src/map-profiles.ts", source }],
    )).toBeUndefined();
  });
});
