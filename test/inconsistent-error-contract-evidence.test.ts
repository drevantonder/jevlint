import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildInconsistentErrorContractEvidence } from "../src/evidence/inconsistent-error-contract.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `export function getUser(id: string) {
  const user = store.get(id);
  if (!user) throw new NotFoundError(id);
  return user;
}

export function getOrg(id: string) {
  const org = store.getOrg(id);
  if (!org) return null;
  return org;
}
`;

const uniform = `export function getUser(id: string) {
  const user = store.get(id);
  if (!user) throw new NotFoundError(id);
  return user;
}

export function getOrg(id: string) {
  const org = store.getOrg(id);
  if (!org) throw new NotFoundError(id);
  return org;
}
`;

const callers = `import { getUser, getOrg } from "./store";
export function handle(userId: string, orgId: string) {
  try {
    return getUser(userId);
  } catch {
    return getOrg(orgId);
  }
}
`;

function candidateFor(filePath: string, source: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("inconsistent error contract evidence", () => {
  it("pairs a throwing lookup with a null-returning sibling", () => {
    const files: ProjectFile[] = [
      { filePath: "src/store.ts", source: smelly },
      { filePath: "src/handler.ts", source: callers },
    ];
    const evidence = buildInconsistentErrorContractEvidence(
      candidateFor("src/store.ts", smelly, "throw new NotFoundError"),
      files,
    );

    expect(evidence).toMatchObject({
      function: { name: "getUser", reportingStyles: ["throw"] },
      siblings: [{ name: "getOrg", reportingStyles: ["return-null"] }],
    });
  });

  it("abstains when every sibling reports the same way", () => {
    const files: ProjectFile[] = [{ filePath: "src/store.ts", source: uniform }];
    const evidence = buildInconsistentErrorContractEvidence(
      candidateFor("src/store.ts", uniform, "throw new NotFoundError"),
      files,
    );

    expect(evidence).toBeUndefined();
  });
});
