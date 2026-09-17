import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildScatteredPolicyEvidence } from "../src/evidence/scattered-policy.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function candidate(owner: ProjectFile) {
  return extractCandidates(owner.filePath, owner.source)
    .find(({ kind }) => kind === "function");
}

describe("scattered policy evidence", () => {
  it("connects structurally equivalent policy decisions across modules", async () => {
    const files = await project("scattered-policy-smelly", [
      "src/route-support.ts",
      "src/account-badge.ts",
      "src/support-page.ts",
    ]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const fn = candidate(owner);
    expect(fn).toBeDefined();
    if (!fn) return;

    const evidence = buildScatteredPolicyEvidence(fn, files);

    expect(evidence).toMatchObject({
      function: { name: "routeSupport", filePath: "src/route-support.ts" },
      scatteredPolicies: [{
        candidate: {
          condition: "account.plan === \"enterprise\" && account.status === \"active\"",
          signature: {
            memberNames: ["plan", "status"],
            literalValues: ["active", "enterprise"],
            operators: ["&&", "===", "==="],
          },
        },
        repositoryMatches: [expect.objectContaining({
          filePath: "src/account-badge.ts",
          functionName: "accountBadge",
          condition: "account.plan === \"enterprise\" && account.status === \"active\"",
        })],
      }],
      callers: [expect.objectContaining({
        filePath: "src/support-page.ts",
        call: "routeSupport(account)",
      })],
    });
  });

  it.each([
    ["scattered-policy-independent", ["src/tax-report.ts", "src/campaign.ts"]],
    ["scattered-policy-boundary", ["src/payments-adapter.ts", "src/crm-adapter.ts"]],
    ["scattered-policy-ambiguous", ["src/refresh-workspace.ts", "src/index-workspace.ts"]],
  ])("collects matches without deciding the semantics for %s", async (name, paths) => {
    const files = await project(name, paths);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const fn = candidate(owner);
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildScatteredPolicyEvidence(fn, files)).toMatchObject({
      scatteredPolicies: [expect.objectContaining({
        repositoryMatches: [expect.objectContaining({ filePath: paths[1] })],
      })],
    });
  });

  it("abstains when the repository does not repeat the decision structure", () => {
    const source = `
      export function route(account: Account) {
        if (account.plan === "enterprise" && account.status === "active") return "priority";
        return "standard";
      }
    `;
    const fn = extractCandidates("src/route.ts", source)
      .find(({ kind }) => kind === "function");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildScatteredPolicyEvidence(fn, [{ filePath: "src/route.ts", source }]))
      .toBeUndefined();
  });
});
