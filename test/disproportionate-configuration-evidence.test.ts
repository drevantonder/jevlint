import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDisproportionateConfigurationEvidence } from "../src/evidence/disproportionate-configuration.js";
import type { ProjectFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/disproportionate-config-smelly/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

describe("disproportionate configuration evidence", () => {
  it("connects an option type to functions and observed call-site combinations", async () => {
    const projectFiles = await Promise.all([
      "src/send-notification.ts",
      "src/welcome.ts",
      "src/reset.ts",
    ].map(load));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildDisproportionateConfigurationEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      configuration: {
        name: "NotificationOptions",
        source: expect.stringContaining("afterSend"),
      },
      configuredFunctions: [
        expect.objectContaining({
          name: "sendNotification",
          callers: [
            expect.objectContaining({ filePath: "src/welcome.ts" }),
            expect.objectContaining({ filePath: "src/reset.ts" }),
          ],
        }),
      ],
    });
  });

  it("supports object-shaped option type aliases", () => {
    const source = `
      export type QueryOptions = { limit?: number; cursor?: string };
      export function query(options: QueryOptions) { return database.query(options); }
    `;
    const candidate = extractCandidates("src/query.ts", source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildDisproportionateConfigurationEvidence(
      candidate,
      [{ filePath: "src/query.ts", source }],
    )).toMatchObject({ configuration: { name: "QueryOptions", memberCount: 2 } });
  });

  it("abstains from an interface that is not used as configuration", () => {
    const source = "export interface User { id: string; name: string }";
    const candidate = extractCandidates("src/user.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(buildDisproportionateConfigurationEvidence(candidate, [{ filePath: "src/user.ts", source }]))
      .toBeUndefined();
  });
});
