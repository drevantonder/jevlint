import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildMixedResponsibilitiesEvidence } from "../src/evidence/mixed-responsibilities.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function functionCandidate(owner: ProjectFile) {
  return extractCandidates(owner.filePath, owner.source)
    .find(({ kind }) => kind === "function");
}

describe("mixed responsibilities evidence", () => {
  it("shows Jev calls grouped by the modules that own them", async () => {
    const files = await project("mixed-responsibilities-smelly", [
      "src/update-profile.ts",
      "src/customer-store.ts",
      "src/revenue-report.ts",
      "src/mailer.ts",
      "src/session-store.ts",
      "src/profile-page.ts",
    ]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = functionCandidate(owner);
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildMixedResponsibilitiesEvidence(candidate, files);

    expect(evidence).toMatchObject({
      function: {
        name: "updateProfile",
        filePath: "src/update-profile.ts",
        source: expect.stringContaining("sendFinanceDigest"),
      },
      collaborators: [
        expect.objectContaining({
          source: "./customer-store.js",
          ownership: "project-module",
          calls: [expect.objectContaining({ expression: "saveCustomer(input)" })],
        }),
        expect.objectContaining({
          source: "./revenue-report.js",
          ownership: "project-module",
          calls: [expect.objectContaining({ expression: "renderRevenueDigest()" })],
        }),
        expect.objectContaining({
          source: "./mailer.js",
          ownership: "project-module",
          calls: [expect.objectContaining({ expression: "sendFinanceDigest(digest)" })],
        }),
        expect.objectContaining({
          source: "./session-store.js",
          ownership: "project-module",
          calls: [expect.objectContaining({ expression: "deleteExpiredSessions()" })],
        }),
      ],
      callers: [expect.objectContaining({
        filePath: "src/profile-page.ts",
        call: "updateProfile(form)",
      })],
    });
  });

  it.each([
    ["mixed-responsibilities-cohesive", [
      "src/fulfill-order.ts",
      "src/inventory.ts",
      "src/payments.ts",
      "src/shipments.ts",
      "src/orders.ts",
    ]],
    ["mixed-responsibilities-boundary", [
      "src/register-customer-controller.ts",
      "src/http.ts",
      "src/register-customer.ts",
      "src/responses.ts",
    ]],
    ["mixed-responsibilities-ambiguous", [
      "src/refresh-workspace.ts",
      "src/catalog.ts",
      "src/cache.ts",
      "src/telemetry.ts",
    ]],
  ])("collects the same factual evidence for %s", async (name, paths) => {
    const files = await project(name, paths);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = functionCandidate(owner);
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildMixedResponsibilitiesEvidence(candidate, files)).toMatchObject({
      collaborators: expect.arrayContaining([
        expect.objectContaining({ ownership: "project-module" }),
        expect.objectContaining({ ownership: "project-module" }),
      ]),
    });
  });

  it("abstains when a function does not cross responsibility owners", () => {
    const source = `
      import { normalize, save } from "./profiles.js";
      export function updateProfile(input: Profile) {
        return save(normalize(input));
      }
    `;
    const candidate = extractCandidates("src/update-profile.ts", source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildMixedResponsibilitiesEvidence(candidate, [
      { filePath: "src/update-profile.ts", source },
      { filePath: "src/profiles.ts", source: "export const normalize = () => {}; export const save = () => {};" },
    ])).toBeUndefined();
  });
});
