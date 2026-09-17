import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildTransportCoupledDomainEvidence } from "../src/evidence/transport-coupled-domain.js";
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

describe("transport-coupled domain evidence", () => {
  it("shows Jev the transport API, domain module, and repository callers", async () => {
    const projectFiles = await project("domain-transport-positive", [
      "src/domain/approve-refund.ts",
      "src/http/refund-route.ts",
      "src/persistence/refund-store.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = namedFunction(owner, "approveRefund");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildTransportCoupledDomainEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: {
        name: "approveRefund",
        exported: true,
        filePath: "src/domain/approve-refund.ts",
        source: expect.stringContaining("manager-approval-required"),
      },
      transport: {
        imports: [
          { source: "express", local: "Request", imported: "Request" },
        ],
        parameters: [
          { name: "request", source: "request: Request" },
        ],
        operations: expect.arrayContaining([
          "request.params",
          "request.header",
          "request.user",
        ]),
      },
      callers: [
        expect.objectContaining({
          filePath: "src/http/refund-route.ts",
          call: "approveRefund(request)",
        }),
      ],
    });
  });

  it("keeps transport adapters eligible for semantic exception handling", async () => {
    const projectFiles = await project("domain-transport-negative", [
      "src/http/approve-refund-route.ts",
      "src/http/routes.ts",
      "src/domain/approve-refund.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = namedFunction(owner, "approveRefundRoute");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildTransportCoupledDomainEvidence(candidate, projectFiles)).toMatchObject({
      function: { filePath: "src/http/approve-refund-route.ts" },
      transport: {
        parameters: [
          expect.objectContaining({ name: "request" }),
          expect.objectContaining({ name: "response" }),
        ],
        operations: expect.arrayContaining(["response.status", "response.status(403).json"]),
      },
    });
  });

  it("abstains when Oxc finds no transport mechanism", () => {
    const source = "export function approveRefund(command: ApproveRefund) { return decide(command); }";
    const file = { filePath: "src/domain/approve-refund.ts", source };
    const candidate = namedFunction(file, "approveRefund");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildTransportCoupledDomainEvidence(candidate, [file])).toBeUndefined();
  });
});
