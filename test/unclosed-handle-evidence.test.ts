import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnclosedHandleEvidence } from "../src/evidence/unclosed-handle.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/store.ts", source: ownerSource }];
  const candidate = extractCandidates("src/store.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("loadRecord"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no loadRecord candidate.");
  return { candidate, projectFiles };
}

describe("unclosed handle evidence", () => {
  it("reports an opened handle with an early return before any release", () => {
    const { candidate, projectFiles } = project(
      "export function loadRecord(path: string): string | null {\n"
      + "  const handle = open(path);\n"
      + "  if (path.length === 0) return null;\n"
      + "  const body = handle.read();\n"
      + "  handle.close();\n"
      + "  return body;\n"
      + "}\n",
    );

    const evidence = buildUnclosedHandleEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      acquisitions: [expect.objectContaining({ kind: "open", boundAs: "handle" })],
      earlyReturnWithoutRelease: true,
      ownershipTransfer: { returned: false, registeredWithDisposer: false },
    });
  });

  it("records releases present on the exit path", () => {
    const { candidate, projectFiles } = project(
      "export function loadRecord(path: string): string {\n"
      + "  const handle = open(path);\n"
      + "  try {\n"
      + "    return handle.read();\n"
      + "  } finally {\n"
      + "    handle.close();\n"
      + "  }\n"
      + "}\n",
    );

    expect(buildUnclosedHandleEvidence(candidate, projectFiles)).toMatchObject({
      moduleReleases: expect.any(Array),
      releasesInFunction: [expect.stringContaining("close")],
      earlyReturnWithoutRelease: false,
    });
  });

  it("abstains when nothing is acquired", () => {
    const source = "export function loadRecord(path: string): string {\n"
      + "  return path;\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/store.ts", source }];
    const candidate = extractCandidates("src/store.ts", source)
      .filter(({ kind }) => kind === "function")
      .find(({ source: text }) => text.includes("loadRecord"));
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("Fixture has no candidate.");

    expect(buildUnclosedHandleEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("leaves subscriptions to the subscription rule", () => {
    const { candidate, projectFiles } = project(
      "import { bus } from \"./bus.js\";\n"
      + "export function loadRecord(topic: string): void {\n"
      + "  bus.on(topic, (payload) => String(payload));\n"
      + "}\n",
    );

    expect(buildUnclosedHandleEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
