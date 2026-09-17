import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildOffsetPaginationDriftEvidence } from "../src/evidence/offset-pagination-drift.js";

function candidateFor(source: string, marker: string) {
  const candidate = extractCandidates("src/users.ts", source)
    .find(({ source: text }) => text.includes(marker));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("fixture candidate missing");
  return candidate;
}

const OFFSET_PAGING = `export async function listUsers(offset: number, limit: number) {
  return db.users.findMany({ skip: offset, take: limit });
}`;

const CURSOR_PAGING = `export async function listUsers(cursor: string | null, limit: number) {
  return db.users.findMany({ cursor: cursor ?? undefined, take: limit, orderBy: { id: "asc" } });
}`;

const NO_PAGING = `export async function getUser(id: string) {
  return db.users.findUnique({ where: { id } });
}`;

describe("offset pagination drift evidence", () => {
  it("flags offset paging without a stable ordering key", () => {
    const candidate = candidateFor(OFFSET_PAGING, "listUsers");
    const evidence = buildOffsetPaginationDriftEvidence(candidate, [
      { filePath: "src/users.ts", source: OFFSET_PAGING },
    ]);
    expect(evidence).toMatchObject({
      function: { name: "listUsers", exported: true },
      paginationParams: ["offset", "limit"],
      hasStableOrdering: false,
      unusedCursorParam: null,
    });
  });

  it("records stable ordering for cursor listings", () => {
    const candidate = candidateFor(CURSOR_PAGING, "listUsers");
    const evidence = buildOffsetPaginationDriftEvidence(candidate, [
      { filePath: "src/users.ts", source: CURSOR_PAGING },
    ]);
    expect(evidence?.hasStableOrdering).toBe(true);
  });

  it("abstains when no pagination parameters exist", () => {
    const candidate = candidateFor(NO_PAGING, "getUser");
    expect(buildOffsetPaginationDriftEvidence(candidate, [
      { filePath: "src/users.ts", source: NO_PAGING },
    ])).toBeUndefined();
  });
});
