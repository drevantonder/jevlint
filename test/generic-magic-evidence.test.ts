import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildGenericMagicEvidence } from "../src/evidence/generic-magic.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/generic-magic-smelly/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

describe("generic magic evidence", () => {
  it("shows dynamic mechanisms beside their concrete uses", async () => {
    const projectFiles = await Promise.all(["src/map-user.ts", "src/load-user.ts"].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildGenericMagicEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "hydrateUser" },
      dynamicOperations: expect.arrayContaining([
        "Object.entries",
        "Reflect.set",
        "row[column]",
      ]),
      callers: [
        expect.objectContaining({
          filePath: "src/load-user.ts",
          call: "hydrateUser(row)",
        }),
      ],
    });
  });

  it("recognizes proxy-based indirection", () => {
    const source = `
      export function wrap(target: object) {
        return new Proxy(target, { get: (_value, key) => registry[key] });
      }
    `;
    const candidate = extractCandidates("src/proxy.ts", source)
      .find(({ source: candidateSource }) => candidateSource.includes("function wrap"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildGenericMagicEvidence(candidate, [{ filePath: "src/proxy.ts", source }]))
      .toMatchObject({ dynamicOperations: expect.arrayContaining(["new Proxy"]) });
  });

  it("does not attribute nested callback operations to the enclosing function", async () => {
    const filePath = "src/nested-operations.ts";
    const source = await readFile(
      new URL(
        "./fixtures/repositories/nested-callback-orchestration/src/nested-operations.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const candidate = extractCandidates(filePath, source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildGenericMagicEvidence(candidate, [{ filePath, source }]))
      .toBeUndefined();
  });

  it("abstains from ordinary property access", () => {
    const source = "export function userName(user: User) { return user.name; }";
    const candidate = extractCandidates("src/user.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(buildGenericMagicEvidence(candidate, [{ filePath: "src/user.ts", source }]))
      .toBeUndefined();
  });
});
