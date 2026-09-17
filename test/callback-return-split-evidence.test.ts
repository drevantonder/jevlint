import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildCallbackReturnSplitEvidence } from "../src/evidence/callback-return-split.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/callback-return-split-smelly/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

const uniform = `export async function get(key: string): Promise<string | undefined> {
  return store.get(key);
}
export async function save(key: string, value: string): Promise<void> {
  store.set(key, value);
}
const store = new Map<string, string>();
`;

describe("callback return split evidence", () => {
  it("flags a callback-styled export beside return-styled siblings reached by one client", async () => {
    const projectFiles = await Promise.all(["src/store.ts", "src/app.ts"].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind, source }) => kind === "function" && source.includes("cb:"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildCallbackReturnSplitEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "remove", style: "callback", callbackParameters: ["cb"] },
      moduleStyle: { majority: "return", callbackCount: 1, returnCount: 2 },
    });
    expect(evidence?.siblings.map(({ name }) => name)).toEqual(
      expect.arrayContaining(["get", "save"]),
    );
    expect(evidence?.returnStyleClients.map(({ filePath }) => filePath)).toContain("src/app.ts");
    expect(evidence?.callbackStyleClients.map(({ filePath }) => filePath)).toContain("src/app.ts");
  });

  it("abstains when every sibling shares one completion style", () => {
    const candidate = extractCandidates("src/store.ts", uniform)
      .find(({ kind, source }) => kind === "function" && source.includes("save"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildCallbackReturnSplitEvidence(candidate, [{ filePath: "src/store.ts", source: uniform }]))
      .toBeUndefined();
  });

  it("dispatches through the rule registry", async () => {
    const projectFiles = await Promise.all(["src/store.ts", "src/app.ts"].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind, source }) => kind === "function" && source.includes("cb:"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const result = buildRuleEvidence("jev/no-callback-return-split", candidate, projectFiles);

    expect(result.handled).toBe(true);
    expect(result.handled && result.evidence).toBeDefined();
  });
});
