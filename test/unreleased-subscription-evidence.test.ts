import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnreleasedSubscriptionEvidence } from "../src/evidence/unreleased-subscription.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/server.ts", source: ownerSource }];
  const candidate = extractCandidates("src/server.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("handleRequest") || source.includes("watcher"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no handler candidate.");
  return { candidate, projectFiles };
}

describe("unreleased subscription evidence", () => {
  it("reports a per-request listener with no removal in the module", () => {
    const { candidate, projectFiles } = project(
      "import { bus } from \"./bus.js\";\n"
      + "export function handleRequest(req: { id: string }): void {\n"
      + "  bus.on(\"data\", (payload) => req.id + String(payload));\n"
      + "}\n",
    );

    const evidence = buildUnreleasedSubscriptionEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "handleRequest" },
      acquisitions: [expect.objectContaining({ kind: "on" })],
      removalsInModule: [],
      hasEffectCleanupReturn: false,
      ownerLifetime: expect.objectContaining({ hasRequestParameters: true }),
    });
  });

  it("records matching removals present in the same module", () => {
    const { candidate, projectFiles } = project(
      "import { bus } from \"./bus.js\";\n"
      + "export function handleRequest(req: { id: string }): () => void {\n"
      + "  const onData = (payload: unknown): void => {};\n"
      + "  bus.on(\"data\", onData);\n"
      + "  return () => { bus.removeEventListener(\"data\", onData); };\n"
      + "}\n",
    );

    expect(buildUnreleasedSubscriptionEvidence(candidate, projectFiles)).toMatchObject({
      removalsInModule: [expect.stringContaining("removeEventListener")],
      hasEffectCleanupReturn: true,
    });
  });

  it("abstains when nothing is acquired", () => {
    const source = "export function handleRequest(req: { id: string }): string {\n"
      + "  return req.id;\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/server.ts", source }];
    const candidate = extractCandidates("src/server.ts", source)
      .filter(({ kind }) => kind === "function")
      .find(({ source: text }) => text.includes("handleRequest"));
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("Fixture has no candidate.");

    expect(buildUnreleasedSubscriptionEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
