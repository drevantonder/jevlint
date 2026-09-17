import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildImplicitAtomicityEvidence } from "../src/evidence/implicit-atomicity.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function firstNamedFunction(projectFiles: ProjectFile[]) {
  const owner = projectFiles[0];
  expect(owner).toBeDefined();
  if (!owner) throw new Error("Missing fixture owner.");
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find(({ kind, source }) => kind === "function" && source.includes("function "));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Missing function candidate.");
  return candidate;
}

describe("implicit atomicity evidence", () => {
  it("extracts the ordered durable effects in a balance transfer", async () => {
    const files = await project("implicit-atomicity-positive", [
      "src/transfer-funds.ts",
      "src/api.ts",
    ]);

    const evidence = buildImplicitAtomicityEvidence(firstNamedFunction(files), files);

    expect(evidence).toMatchObject({
      function: { name: "transferFunds", exported: true },
      operations: [
        { action: "debit", expression: "accounts.debit(transfer.fromAccountId, transfer.amount)", awaited: true },
        { action: "credit", expression: "accounts.credit(transfer.toAccountId, transfer.amount)", awaited: true },
      ],
      transactionSignals: [],
      callers: [expect.objectContaining({ filePath: "src/api.ts" })],
    });
  });

  it("keeps independent persistence and telemetry effects for semantic rejection", async () => {
    const files = await project("implicit-atomicity-negative", [
      "src/save-profile-and-track.ts",
      "src/profile-page.ts",
    ]);

    expect(buildImplicitAtomicityEvidence(firstNamedFunction(files), files)).toMatchObject({
      function: { name: "saveProfileAndTrack" },
      operations: [
        expect.objectContaining({ action: "save" }),
        expect.objectContaining({ action: "track" }),
      ],
      transactionSignals: [],
    });
  });

  it("extracts a transaction boundary around nested writes", async () => {
    const files = await project("implicit-atomicity-exception", [
      "src/transfer-funds-transactional.ts",
      "src/api.ts",
    ]);

    expect(buildImplicitAtomicityEvidence(firstNamedFunction(files), files)).toMatchObject({
      function: { name: "transferFundsTransactional" },
      operations: [
        expect.objectContaining({ action: "debit" }),
        expect.objectContaining({ action: "credit" }),
      ],
      transactionSignals: [
        { kind: "call", expression: expect.stringContaining("database.transaction") },
      ],
    });
  });

  it("shows compensation and catch structure for an ambiguous cross-service saga", async () => {
    const files = await project("implicit-atomicity-ambiguous", [
      "src/place-order-saga.ts",
      "src/checkout.ts",
    ]);

    expect(buildImplicitAtomicityEvidence(firstNamedFunction(files), files)).toMatchObject({
      function: { name: "placeOrderSaga" },
      operations: [
        expect.objectContaining({ action: "reserve" }),
        expect.objectContaining({ action: "charge" }),
        expect.objectContaining({ action: "release" }),
      ],
      errorHandling: {
        tryStatements: [expect.objectContaining({ hasCatch: true })],
        compensatingOperations: [expect.objectContaining({ action: "release" })],
      },
    });
  });

  it("abstains when there is only one structural effect candidate", () => {
    const source = "export async function saveUser(user: User) { await users.save(user); }";
    const files = [{ filePath: "src/save-user.ts", source }];

    expect(buildImplicitAtomicityEvidence(firstNamedFunction(files), files)).toBeUndefined();
  });
});
