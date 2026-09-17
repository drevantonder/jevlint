import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildCrypticAbbreviationEvidence } from "../src/evidence/cryptic-abbreviation.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const SMELLY = "// Computes the user account balance for display.\n"
  + "export interface AccountRecord {\n"
  + "  user: string;\n"
  + "  account: string;\n"
  + "  balance: number;\n"
  + "}\n"
  + "export function calcUsrAcctBal(usrAcct: AccountRecord): number {\n"
  + "  return usrAcct.balance;\n"
  + "}\n";

function candidateFor(filePath: string, source: string, snippet: string): Candidate {
  const candidate = extractCandidates(filePath, source)
    .filter(({ kind }) => kind === "function")
    .find(({ source: text }) => text.includes(snippet));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no candidate.");
  return candidate;
}

describe("cryptic abbreviation evidence", () => {
  it("flags stacked shortenings while the full terms sit nearby", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/billing.ts", source: SMELLY }];

    const evidence = buildCrypticAbbreviationEvidence(
      candidateFor("src/billing.ts", SMELLY, "calcUsrAcctBal"),
      projectFiles,
    );

    expect(evidence).toMatchObject({
      function: { name: "calcUsrAcctBal" },
      identifiers: expect.arrayContaining([
        expect.objectContaining({
          name: "calcUsrAcctBal",
          suspectSegments: expect.arrayContaining(["calc", "usr", "acct", "bal"]),
          expandedTermsPresent: expect.arrayContaining(["user", "account", "balance"]),
        }),
      ]),
    });
  });

  it("abstains for dictionary words", () => {
    const source = "export function calculateTotal(items: number[]): number {\n"
      + "  return items.reduce((sum, item) => sum + item, 0);\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/billing.ts", source }];

    expect(buildCrypticAbbreviationEvidence(
      candidateFor("src/billing.ts", source, "calculateTotal"),
      projectFiles,
    )).toBeUndefined();
  });
});
