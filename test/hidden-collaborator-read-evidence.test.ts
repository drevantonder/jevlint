import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildHiddenCollaboratorReadEvidence } from "../src/evidence/hidden-collaborator-read.js";
import type { ProjectFile } from "../src/types.js";

const FLAGS: ProjectFile = {
  filePath: "src/flags.ts",
  source: "export const flags = { vip: new Set<string>() };\n"
    + "export function enrollVip(id: string): void {\n"
    + "  flags.vip.add(id);\n"
    + "}\n",
};

const CONFIG: ProjectFile = {
  filePath: "src/config.ts",
  source: "export const TAX_RATE = 0.2;\n",
};

function changedFunction(ownerSource: string, extra: ProjectFile[] = []) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/policy.ts", source: ownerSource }, ...extra];
  const candidate = extractCandidates("src/policy.ts", ownerSource)
    .find(({ kind }) => kind === "function");
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no function candidate.");
  expect(candidate.kind).toBe("function");
  return { candidate, projectFiles };
}

describe("hidden collaborator read evidence", () => {
  it("reports imported state that decides a domain branch with an external writer", () => {
    const { candidate, projectFiles } = changedFunction(
      "import { flags } from \"./flags.js\";\n"
      + "export function discount(userId: string): number {\n"
      + "  return flags.vip.has(userId) ? 0.2 : 0;\n"
      + "}\n",
      [FLAGS],
    );

    const evidence = buildHiddenCollaboratorReadEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "discount", exported: true },
      reads: [expect.objectContaining({ root: "flags", ownership: "imported-binding" })],
      importedTargets: [{ local: "flags", source: "./flags.js" }],
    });
    expect(evidence?.externalWriters.length).toBeGreaterThan(0);
  });

  it("reports receiver state reads", () => {
    const ownerSource = "export class Pricer {\n"
      + "  constructor(private rate: number) {}\n"
      + "  total(price: number): number {\n"
      + "    return price > 100 ? price * this.rate : price;\n"
      + "  }\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/policy.ts", source: ownerSource }];
    const candidate = extractCandidates("src/policy.ts", ownerSource)
      .find(({ kind, source }) => kind === "function" && source.includes("this.rate"));
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("Fixture has no function candidate.");
    expect(candidate.kind).toBe("function");

    const evidence = buildHiddenCollaboratorReadEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({ function: { name: "total" } });
    expect(evidence?.reads.some(({ ownership, root }) => ownership === "this" && root === "this")).toBe(true);
  });

  it("abstains when the import is only a call callee", () => {
    const { candidate, projectFiles } = changedFunction(
      "import { format } from \"./format.js\";\n"
      + "export function label(total: number): string {\n"
      + "  return format(total);\n"
      + "}\n",
      [{ filePath: "src/format.ts", source: "export function format(total: number): string {\n  return String(total);\n}\n" }],
    );

    expect(buildHiddenCollaboratorReadEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains for reads of a literal const with no writer", () => {
    const { candidate, projectFiles } = changedFunction(
      "import { TAX_RATE } from \"./config.js\";\n"
      + "export function withTax(price: number): number {\n"
      + "  return price > 0 ? price * (1 + TAX_RATE) : price;\n"
      + "}\n",
      [CONFIG],
    );

    expect(buildHiddenCollaboratorReadEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when the collaborator name is shadowed by a parameter", () => {
    const { candidate, projectFiles } = changedFunction(
      "import { flags } from \"./flags.js\";\n"
      + "export function discount(flags: { vip: Set<string> }, userId: string): number {\n"
      + "  return flags.vip.has(userId) ? 0.2 : 0;\n"
      + "}\n",
      [FLAGS],
    );

    expect(buildHiddenCollaboratorReadEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
