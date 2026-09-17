import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildStaleCommentEvidence } from "../src/evidence/stale-comment.js";
import type { ProjectFile, SourceFile } from "../src/types.js";

function commentCandidate(source: string, excerpt: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/fetch.ts", source }];
  const candidate = extractCandidates("src/fetch.ts", source)
    .find(({ kind, source: text }) => kind === "comment" && text.includes(excerpt));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error(`Fixture has no comment containing ${excerpt}.`);
  return { candidate, projectFiles };
}

describe("stale comment evidence", () => {
  it("reports a retry count contradicted by a loop-free body", () => {
    const { candidate, projectFiles } = commentCandidate(
      "// Retries up to 3 times on failure.\n"
      + "export function fetchData(url: string): string {\n"
      + "  return get(url);\n"
      + "}\n",
      "Retries up to 3 times",
    );

    const evidence = buildStaleCommentEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      claims: [expect.objectContaining({ kind: "count" })],
      adjoiningCode: {
        functionName: "fetchData",
        signals: expect.objectContaining({ hasRetryLoop: false }),
      },
      contradictions: [expect.objectContaining({ codeFact: expect.stringContaining("no retry loop") })],
    });
  });

  it("marks the edited-body-beside-untouched-comment shape via changed lines", () => {
    const source = "// Returns null when missing.\n"
      + "export function lookup(id: string): string {\n"
      + "  throw new Error(`missing ${id}`);\n"
      + "}\n";
    const { candidate, projectFiles } = commentCandidate(source, "Returns null");
    const changes: SourceFile[] = [{
      filePath: "src/fetch.ts",
      source,
      oldSource: null,
      changedLines: [{ start: 2, end: 4 }],
    }];

    const evidence = buildStaleCommentEvidence(candidate, projectFiles, changes);

    expect(evidence).toMatchObject({
      claims: [expect.objectContaining({ kind: "outcome" })],
      changedSide: "code",
      contradictions: [expect.objectContaining({ claim: expect.stringContaining("Returns null") })],
    });
  });

  it("abstains when the comment makes no behavior claim", () => {
    const { candidate, projectFiles } = commentCandidate(
      "// Keep this adapter so callers do not depend on the vendor API.\n"
      + "export function fetchData(url: string): string {\n"
      + "  return get(url);\n"
      + "}\n",
      "Keep this adapter",
    );

    expect(buildStaleCommentEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
