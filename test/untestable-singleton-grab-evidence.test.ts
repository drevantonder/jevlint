import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUntestableSingletonGrabEvidence } from "../src/evidence/untestable-singleton-grab.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function functionCandidate(owner: ProjectFile, snippet: string) {
  return extractCandidates(owner.filePath, owner.source)
    .filter(({ kind, source }) => kind === "function" && source.includes(snippet))
    .sort((left, right) => left.source.length - right.source.length)[0];
}

describe("untestable singleton grab evidence", () => {
  it("flags a domain function reaching an ambient database singleton", async () => {
    const projectFiles = await project("singleton-smelly", ["src/pricing.ts", "src/db.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = functionCandidate(owner, "db.rateFor");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUntestableSingletonGrabEvidence(candidate, projectFiles)).toMatchObject({
      grabs: [expect.objectContaining({ module: "./db.js", local: "getDatabase" })],
      injectedViaParam: false,
      likelyWiring: false,
    });
  });

  it("marks composition-root wiring as mitigating context", async () => {
    const projectFiles = await project("singleton-wired", [
      "src/wiring.ts",
      "src/pricing.ts",
      "src/db.ts",
    ]);
    const owner = projectFiles.find((file) => file.filePath === "src/wiring.ts");
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = functionCandidate(owner, "priceOrder(order");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUntestableSingletonGrabEvidence(candidate, projectFiles)).toMatchObject({
      grabs: [expect.objectContaining({ local: "getDatabase" })],
      likelyWiring: true,
    });
  });

  it("abstains when the domain function takes no ambient state", async () => {
    const projectFiles = await project("singleton-wired", [
      "src/wiring.ts",
      "src/pricing.ts",
      "src/db.ts",
    ]);
    const owner = projectFiles.find((file) => file.filePath === "src/pricing.ts");
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = functionCandidate(owner, "order.amount");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildUntestableSingletonGrabEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
