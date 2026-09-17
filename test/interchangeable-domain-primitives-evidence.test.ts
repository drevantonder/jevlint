import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildInterchangeableDomainPrimitivesEvidence } from "../src/evidence/interchangeable-domain-primitives.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function namedFunction(file: ProjectFile, name: string) {
  return extractCandidates(file.filePath, file.source)
    .find(({ kind, source }) => kind === "function" && source.includes(`function ${name}`));
}

describe("interchangeable domain primitive evidence", () => {
  it("shows Jev same-typed parameters and concrete repository calls", async () => {
    const projectFiles = await project("domain-primitives-positive", [
      "src/domain/transfer-funds.ts",
      "src/application/execute-transfer.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = namedFunction(owner, "transferFunds");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildInterchangeableDomainPrimitivesEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: {
        name: "transferFunds",
        exported: true,
        filePath: "src/domain/transfer-funds.ts",
      },
      primitiveGroups: [
        {
          type: "string",
          parameters: [
            { index: 0, name: "sourceAccountId", source: "sourceAccountId: string" },
            { index: 1, name: "destinationAccountId", source: "destinationAccountId: string" },
          ],
        },
      ],
      callers: [
        expect.objectContaining({
          filePath: "src/application/execute-transfer.ts",
          arguments: [
            "command.sourceAccountId",
            "command.destinationAccountId",
            "command.amountCents",
          ],
        }),
      ],
      consumers: [
        expect.objectContaining({
          source: expect.stringContaining("command.destinationAccountId"),
        }),
      ],
    });
  });

  it("keeps ordinary display primitives eligible for semantic rejection", async () => {
    const projectFiles = await project("domain-primitives-negative", [
      "src/presentation/format-display-name.ts",
      "src/presentation/customer-label.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = namedFunction(owner, "formatDisplayName");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildInterchangeableDomainPrimitivesEvidence(candidate, projectFiles)).toMatchObject({
      primitiveGroups: [
        {
          type: "string",
          parameters: [
            expect.objectContaining({ name: "givenName" }),
            expect.objectContaining({ name: "familyName" }),
          ],
        },
      ],
    });
  });

  it("abstains unless at least two parameters share one explicit primitive type", () => {
    const source = "export function credit(accountId: string, amountCents: number) { return ledger.credit(accountId, amountCents); }";
    const file = { filePath: "src/domain/credit.ts", source };
    const candidate = namedFunction(file, "credit");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildInterchangeableDomainPrimitivesEvidence(candidate, [file])).toBeUndefined();
  });
});
