import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildPassThroughWrapperEvidence } from "../src/evidence/pass-through-wrapper.js";
import type { ProjectFile } from "../src/types.js";

async function fixture(path: string): Promise<string> {
  return readFile(new URL(`./fixtures/repositories/pass-through-smelly/${path}`, import.meta.url), "utf8");
}

describe("pass-through wrapper evidence", () => {
  it("shows Jev the delegated target, module boundary, and actual callers", async () => {
    const projectFiles: ProjectFile[] = await Promise.all([
      "src/get-user.ts",
      "src/profile.ts",
    ].map(async (filePath) => ({ filePath, source: await fixture(filePath) })));
    const wrapper = projectFiles[0];
    expect(wrapper).toBeDefined();
    if (!wrapper) return;
    const candidate = extractCandidates(wrapper.filePath, wrapper.source)
      .find(({ source }) => source.includes("function getUserById"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildPassThroughWrapperEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: {
        name: "getUserById",
        exported: true,
        source: expect.stringContaining("usersRepository.getUserById(id)"),
      },
      delegation: {
        call: "usersRepository.getUserById(id)",
        targetRoot: "usersRepository",
        importedFrom: null,
        ownership: "same-module",
        targetModule: {
          filePath: "src/get-user.ts",
          source: expect.stringContaining("database.users.find(id)"),
        },
      },
      callers: [
        {
          filePath: "src/profile.ts",
          call: "getUserById(userId)",
        },
      ],
    });
  });

  it("includes callers from the wrapper's own module", async () => {
    const filePath = "src/foundation.ts";
    const source = await readFile(
      new URL("./fixtures/repositories/pass-through-same-file/src/foundation.ts", import.meta.url),
      "utf8",
    );
    const candidate = extractCandidates(filePath, source)
      .find(({ source: candidateSource }) => candidateSource.includes("operations.read(props"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildPassThroughWrapperEvidence(candidate, [{ filePath, source }]);

    expect(evidence).toMatchObject({
      function: { name: "readFoundation" },
      callers: [{
        filePath,
        call: "readFoundation(operations, props, policy, true)",
      }],
    });
  });

  it("supports exported arrow-function wrappers", () => {
    const source = `
      const usersRepository = { getUserById: (id: string) => database.users.find(id) };
      export const getUserById = (id: string) => usersRepository.getUserById(id);
    `;
    const candidate = extractCandidates("src/get-user.ts", source)
      .find(({ source: candidateSource }) => candidateSource.includes("usersRepository.getUserById"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildPassThroughWrapperEvidence(
      candidate,
      [{ filePath: "src/get-user.ts", source }],
    )).toMatchObject({
      function: { name: "getUserById", exported: true },
      delegation: { ownership: "same-module" },
    });
  });

  it("does not manufacture wrapper evidence for functions that add behavior", () => {
    const source = `export function save(value: string) {
      audit(value);
      return repository.save(value);
    }`;
    const candidate = extractCandidates("src/save.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildPassThroughWrapperEvidence(candidate, [{ filePath: "src/save.ts", source }]))
      .toBeUndefined();
  });
});
