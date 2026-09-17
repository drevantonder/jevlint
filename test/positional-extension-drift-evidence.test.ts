import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildPositionalExtensionDriftEvidence } from "../src/evidence/positional-extension-drift.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `export function fetchUser(id: string, verbose?: boolean, timeout?: number) {
  return { id, verbose, timeout };
}

export function fetchOrg(id: string, options: { verbose?: boolean; timeout?: number }) {
  return { id, ...options };
}
`;

const noBag = `export function fetchUser(id: string, verbose?: boolean, timeout?: number) {
  return { id, verbose, timeout };
}

export function fetchOrg(id: string, limit?: number) {
  return { id, limit };
}
`;

const callers = `import { fetchUser } from "./api";
export function handle(id: string) {
  return fetchUser(id, undefined, 5000);
}
`;

function candidateFor(filePath: string, source: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("positional extension drift evidence", () => {
  it("pairs trailing positionals with an options-bag sibling", () => {
    const files: ProjectFile[] = [
      { filePath: "src/api.ts", source: smelly },
      { filePath: "src/handler.ts", source: callers },
    ];
    const evidence = buildPositionalExtensionDriftEvidence(
      candidateFor("src/api.ts", smelly, "verbose?: boolean"),
      files,
    );

    expect(evidence).toMatchObject({
      function: { name: "fetchUser" },
      extension: { totalPositional: 3, trailing: [{ name: "verbose" }, { name: "timeout" }] },
      siblingsWithOptionsBag: [{ name: "fetchOrg" }],
      callSummary: { withUndefinedPlaceholder: 1 },
    });
  });

  it("abstains when no sibling uses an options bag", () => {
    const files: ProjectFile[] = [{ filePath: "src/api.ts", source: noBag }];
    const evidence = buildPositionalExtensionDriftEvidence(
      candidateFor("src/api.ts", noBag, "verbose?: boolean"),
      files,
    );

    expect(evidence).toBeUndefined();
  });
});
