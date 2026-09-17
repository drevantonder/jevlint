import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildLocaleBlindOrderingEvidence } from "../src/evidence/locale-blind-ordering.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `export function listNames(users: { name: string }[]) {
  return users.map((user) => user.name).sort();
}
`;

const relational = `export function sortUsers(users: { name: string }[]) {
  return users.sort((a, b) => (a.name < b.name ? -1 : 1));
}
`;

const cleaned = `const collator = new Intl.Collator("en");
export function listNames(users: { name: string }[]) {
  return users.map((user) => user.name).sort((a, b) => collator.compare(a, b));
}
`;

const numericLoop = `export function takeTop(scores: number[], limit: number) {
  const ranked = scores.sort((a, b) => b - a);
  const top: number[] = [];
  for (let index = 0; index < limit; index += 1) top.push(ranked[index]!);
  return top;
}
`;

function project(source: string, filePath = "src/users.ts", extra: ProjectFile[] = []) {
  return { files: [{ filePath, source }, ...extra], filePath };
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("locale blind ordering evidence", () => {
  it("captures a bare sort over display names", () => {
    const { files, filePath } = project(smelly);
    const evidence = buildLocaleBlindOrderingEvidence(candidateFor(smelly, filePath, "listNames"), files);

    expect(evidence).toMatchObject({
      function: { name: "listNames", exported: true },
      sorts: [{ comparatorKind: "none", localeAware: false }],
      mitigations: { collatorInFunction: false, collatorInModule: false },
    });
  });

  it("marks a relational comparator and its in-sort comparison", () => {
    const { files, filePath } = project(relational);
    const evidence = buildLocaleBlindOrderingEvidence(candidateFor(relational, filePath, "sortUsers"), files);

    expect(evidence?.sorts).toMatchObject([{ comparatorKind: "relational", localeAware: false }]);
    expect(evidence?.comparisons).toMatchObject([{ inSortComparator: true }]);
    expect(evidence?.comparisons[0]?.expression).toContain("a.name < b.name");
  });

  it("abstains when a collator orders the values", () => {
    const { files, filePath } = project(cleaned);
    expect(buildLocaleBlindOrderingEvidence(candidateFor(cleaned, filePath, "listNames"), files))
      .toBeUndefined();
  });

  it("keeps numeric subtraction visible without loop-bound noise", () => {
    const { files, filePath } = project(numericLoop);
    const evidence = buildLocaleBlindOrderingEvidence(candidateFor(numericLoop, filePath, "takeTop"), files);

    expect(evidence?.sorts).toMatchObject([{ comparatorKind: "subtract" }]);
    expect(evidence?.comparisons).toEqual([]);
  });

  it("abstains when nothing is ordered", () => {
    const source = `export function listNames(users: { name: string }[]) {
  return users.map((user) => user.name);
}
`;
    const { files, filePath } = project(source);
    expect(buildLocaleBlindOrderingEvidence(candidateFor(source, filePath, "listNames"), files))
      .toBeUndefined();
  });

  it("includes callers for surface-visibility sensitivity", () => {
    const { files, filePath } = project(smelly, "src/users.ts", [{
      filePath: "src/list.tsx",
      source: `import { listNames } from "./users";\nexport function Names(u: never) { return listNames(u); }`,
    }]);
    const evidence = buildLocaleBlindOrderingEvidence(candidateFor(smelly, filePath, "listNames"), files);
    expect(evidence?.callers).toMatchObject([{ filePath: "src/list.tsx" }]);
  });
});
