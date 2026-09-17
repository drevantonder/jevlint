import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildImpossibleErrorBranchEvidence } from "../src/evidence/impossible-error-branch.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

async function candidateFor(projectFiles: ProjectFile[], filePath: string, marker: string) {
  const owner = projectFiles.find((file) => file.filePath === filePath);
  expect(owner).toBeDefined();
  if (!owner) return undefined;
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find(({ kind, source }) => kind === "function" && source.includes(marker));
  expect(candidate).toBeDefined();
  return candidate;
}

describe("impossible error branch evidence", () => {
  it("shows a clean callee beside the guarding handler", async () => {
    const projectFiles = await project("impossible-error-cases", [
      "src/store.ts",
      "src/service.ts",
      "src/risky.ts",
      "src/capped.ts",
      "src/remote.ts",
    ]);
    const candidate = await candidateFor(projectFiles, "src/service.ts", "priceForPlan");
    if (!candidate) return;

    const evidence = buildImpossibleErrorBranchEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "priceForPlan", exported: true, filePath: "src/service.ts" },
      handlers: [
        {
          kind: "try-catch",
          guardedCalls: [
            {
              callee: "lookupRate",
              ownership: "project-module",
              resolvedFile: "src/store.ts",
              analyzable: true,
              throwsFound: [],
              rejectsFound: [],
            },
          ],
          allCalleesClean: true,
        },
      ],
    });
  });

  it("keeps a throwing callee visible as capable of the guarded failure", async () => {
    const projectFiles = await project("impossible-error-cases", [
      "src/store.ts",
      "src/service.ts",
      "src/risky.ts",
      "src/capped.ts",
      "src/remote.ts",
    ]);
    const candidate = await candidateFor(projectFiles, "src/capped.ts", "capForPlan");
    if (!candidate) return;

    const evidence = buildImpossibleErrorBranchEvidence(candidate, projectFiles);

    expect(evidence?.handlers[0]).toMatchObject({
      kind: "try-catch",
      guardedCalls: [
        {
          callee: "readLimit",
          analyzable: true,
          throwsFound: [expect.stringContaining("throw")],
        },
      ],
      allCalleesClean: false,
    });
  });

  it("abstains when the only guarded callee is external", async () => {
    const projectFiles = await project("impossible-error-cases", [
      "src/store.ts",
      "src/service.ts",
      "src/risky.ts",
      "src/capped.ts",
      "src/remote.ts",
    ]);
    const candidate = await candidateFor(projectFiles, "src/remote.ts", "fetchRemoteTotal");
    if (!candidate) return;

    expect(buildImpossibleErrorBranchEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when the function has no error handler", async () => {
    const projectFiles = await project("impossible-error-cases", [
      "src/store.ts",
      "src/service.ts",
      "src/risky.ts",
      "src/capped.ts",
      "src/remote.ts",
    ]);
    const candidate = await candidateFor(projectFiles, "src/store.ts", "lookupRate");
    if (!candidate) return;

    expect(buildImpossibleErrorBranchEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
