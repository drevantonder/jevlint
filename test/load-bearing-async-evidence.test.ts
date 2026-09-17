import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildLoadBearingAsyncEvidence } from "../src/evidence/load-bearing-async.js";
import type { ProjectFile } from "../src/types.js";

const OWNER = "export async function fetchUser(id: string): Promise<{ name: string }> {\n"
  + "  return getCached(id);\n"
  + "}\n"
  + "declare function getCached(id: string): { name: string };\n";

const CALLER = "import { fetchUser } from \"./users.js\";\n"
  + "export async function show(id: string): Promise<string> {\n"
  + "  const user = await fetchUser(id);\n"
  + "  return user.name;\n"
  + "}\n";

function project(ownerSource: string, callerSource?: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/users.ts", source: ownerSource }];
  if (callerSource !== undefined) {
    projectFiles.push({ filePath: "src/show.ts", source: callerSource });
  }
  const candidate = extractCandidates("src/users.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("fetchUser"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no fetchUser candidate.");
  return { candidate, projectFiles };
}

describe("load-bearing async evidence", () => {
  it("reports an await-less async function awaited by callers", () => {
    const { candidate, projectFiles } = project(OWNER, CALLER);

    const evidence = buildLoadBearingAsyncEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "fetchUser", exported: true },
      callerUsage: {
        awaitingCallSites: [expect.stringContaining("fetchUser")],
      },
    });
  });

  it("abstains when the body already awaits", () => {
    const source = "import { readRemote } from \"./client.js\";\n"
      + "export async function fetchUser(id: string): Promise<string> {\n"
      + "  return readRemote(id);\n"
      + "}\n"
      + "export async function fetchDirect(id: string): Promise<string> {\n"
      + "  return await readRemote(id);\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/users.ts", source }];
    const candidate = extractCandidates("src/users.ts", source)
      .filter(({ kind }) => kind === "function")
      .find(({ source: text }) => text.includes("fetchDirect"));
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("Fixture has no candidate.");

    expect(buildLoadBearingAsyncEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains for non-async functions", () => {
    const source = "export function fetchUser(id: string): string {\n"
      + "  return id;\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/users.ts", source }];
    const candidate = extractCandidates("src/users.ts", source)
      .filter(({ kind }) => kind === "function")
      .find(({ source: text }) => text.includes("fetchUser"));
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("Fixture has no candidate.");

    expect(buildLoadBearingAsyncEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
