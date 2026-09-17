import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildMixedAbsenceConventionEvidence } from "../src/evidence/mixed-absence-convention.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `export function findUser(id: string): User | null {
  const user = store.get(id);
  if (!user) return null;
  return user;
}

export function findOrg(id: string): Org | undefined {
  const org = store.getOrg(id);
  if (!org) return undefined;
  return org;
}
`;

const uniform = `export function findUser(id: string): User | null {
  return store.get(id) ?? null;
}

export function findOrg(id: string): Org | null {
  return store.getOrg(id) ?? null;
}
`;

const callers = `import { findUser, findOrg } from "./store";
export function handle(userId: string, orgId: string) {
  const user = findUser(userId);
  const org = findOrg(orgId);
  return { user, org };
}
`;

function candidateFor(filePath: string, source: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("mixed absence convention evidence", () => {
  it("pairs a null-returning lookup with an undefined-returning sibling", () => {
    const files: ProjectFile[] = [
      { filePath: "src/store.ts", source: smelly },
      { filePath: "src/handler.ts", source: callers },
    ];
    const evidence = buildMixedAbsenceConventionEvidence(
      candidateFor("src/store.ts", smelly, "return null"),
      files,
    );

    expect(evidence).toMatchObject({
      function: { name: "findUser", absenceSpelling: "null" },
      siblings: [{ name: "findOrg", absenceSpelling: "undefined" }],
    });
  });

  it("abstains when every sibling spells absence the same way", () => {
    const files: ProjectFile[] = [{ filePath: "src/store.ts", source: uniform }];
    const evidence = buildMixedAbsenceConventionEvidence(
      candidateFor("src/store.ts", uniform, "store.get(id)"),
      files,
    );

    expect(evidence).toBeUndefined();
  });
});
