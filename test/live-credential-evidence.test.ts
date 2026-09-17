import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildLiveCredentialEvidence } from "../src/evidence/live-credential.js";
import type { ProjectFile } from "../src/types.js";

function changedFunction(filePath: string, ownerSource: string, extra: ProjectFile[] = []) {
  const projectFiles: ProjectFile[] = [{ filePath, source: ownerSource }, ...extra];
  const candidate = extractCandidates(filePath, ownerSource)
    .find(({ kind }) => kind === "function");
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no function candidate.");
  return { candidate, projectFiles };
}

describe("live credential evidence", () => {
  it("reports a token literal reaching a client constructor", () => {
    const { candidate, projectFiles } = changedFunction(
      "src/billing.ts",
      "import { ApiClient } from \"billing-sdk\";\n"
      + "export function connect(): ApiClient {\n"
      + "  const apiKey = \"sk-live-9f2c7be41d84a6f0c3e5\";\n"
      + "  return new ApiClient(apiKey);\n"
      + "}\n",
    );

    const evidence = buildLiveCredentialEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "connect", fileRole: "service" },
      secrets: [{ binding: "apiKey", staged: "assignment", placeholder: false }],
      reachesClient: [{ call: expect.stringContaining("ApiClient") }],
    });
    expect(evidence?.secrets[0]?.entropyBitsPerChar).toBeGreaterThan(3);
  });

  it("marks placeholders in test fixtures as inert signals", () => {
    const { candidate, projectFiles } = changedFunction(
      "test/fixtures/auth.ts",
      "export function testCredentials(): { password: string } {\n"
      + "  const password = \"changeme\";\n"
      + "  return { password };\n"
      + "}\n",
    );

    expect(buildLiveCredentialEvidence(candidate, projectFiles)).toMatchObject({
      function: { fileRole: "test" },
      secrets: [{ binding: "password", placeholder: true }],
      reachesClient: [],
    });
  });

  it("reports env plumbing for the same module", () => {
    const { candidate, projectFiles } = changedFunction(
      "src/billing.ts",
      "export function fallbackKey(): string {\n"
      + "  const apiKey = process.env.API_KEY ?? \"sk-live-9f2c7be41d84\";\n"
      + "  return apiKey;\n"
      + "}\n",
    );

    expect(buildLiveCredentialEvidence(candidate, projectFiles)).toMatchObject({
      envPlumbing: ["API_KEY"],
    });
  });

  it("abstains when the function holds no credential literal", () => {
    const { candidate, projectFiles } = changedFunction(
      "src/billing.ts",
      "export function total(values: number[]): number {\n"
      + "  return values.length;\n"
      + "}\n",
    );

    expect(buildLiveCredentialEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
