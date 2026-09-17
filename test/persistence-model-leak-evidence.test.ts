import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildPersistenceModelLeakEvidence } from "../src/evidence/persistence-model-leak.js";
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

describe("persistence model leak evidence", () => {
  it("shows Jev the returned persistence type, operation, and consumers", async () => {
    const projectFiles = await project("persistence-model-positive", [
      "src/application/load-customer.ts",
      "src/domain/assess-credit.ts",
      "src/persistence/prisma.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = namedFunction(owner, "loadCustomer");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildPersistenceModelLeakEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: {
        name: "loadCustomer",
        exported: true,
        filePath: "src/application/load-customer.ts",
      },
      persistence: {
        imports: expect.arrayContaining([
          { source: "@prisma/client", local: "CustomerRow", imported: "Customer" },
          { source: "../persistence/prisma.js", local: "prisma", imported: "prisma" },
        ]),
        returnType: expect.stringContaining("Promise<CustomerRow | null>"),
        returnedExpressions: [
          "prisma.customer.findUnique({ where: { id: customerId } })",
        ],
        operations: expect.arrayContaining(["prisma.customer.findUnique"]),
        relatedModules: [
          expect.objectContaining({
            filePath: "src/persistence/prisma.ts",
            source: expect.stringContaining("PrismaClient"),
          }),
        ],
      },
      consumers: [
        expect.objectContaining({
          filePath: "src/domain/assess-credit.ts",
          source: expect.stringContaining("customer.credit_limit_cents"),
        }),
      ],
    });
  });

  it("keeps mapped domain entities eligible for semantic rejection", async () => {
    const projectFiles = await project("persistence-model-negative", [
      "src/persistence/customer-repository.ts",
      "src/persistence/prisma.ts",
      "src/domain/customer.ts",
      "src/application/assess-credit.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = namedFunction(owner, "loadCustomer");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildPersistenceModelLeakEvidence(candidate, projectFiles)).toMatchObject({
      persistence: {
        operations: expect.arrayContaining(["prisma.customer.findUnique"]),
        returnedExpressions: expect.arrayContaining([
          "null",
          expect.stringContaining("Customer.restore"),
        ]),
      },
      consumers: [
        expect.objectContaining({ source: expect.stringContaining("customer?.riskBand") }),
      ],
    });
  });

  it("abstains without a persistence-owned dependency", () => {
    const source = "export function loadCustomer(id: CustomerId): Customer { return customers.get(id); }";
    const file = { filePath: "src/domain/load-customer.ts", source };
    const candidate = namedFunction(file, "loadCustomer");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildPersistenceModelLeakEvidence(candidate, [file])).toBeUndefined();
  });
});
