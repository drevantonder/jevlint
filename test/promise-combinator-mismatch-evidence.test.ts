import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildPromiseCombinatorMismatchEvidence } from "../src/evidence/promise-combinator-mismatch.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `export async function syncProviders(order: { id: string }) {
  const [stock, billing, shipping] = await Promise.all([
    reserveStock(order.id),
    chargeCard(order.id),
    bookShipment(order.id),
  ]);
  return { stock, billing, shipping };
}
`;

const homogeneous = `export async function loadDashboard(userId: string, adminId: string) {
  const [profile, settings] = await Promise.all([fetchUser(userId), fetchUser(adminId)]);
  return { profile, settings };
}
`;

const settled = `export async function syncProviders(order: { id: string }) {
  const outcomes = await Promise.allSettled([
    reserveStock(order.id),
    chargeCard(order.id),
  ]);
  return outcomes.filter((outcome) => outcome.status === "fulfilled");
}
`;

function project(source: string, filePath = "src/orders.ts", extra: ProjectFile[] = []) {
  return { files: [{ filePath, source }, ...extra], filePath };
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("promise combinator mismatch evidence", () => {
  it("captures heterogeneous all legs consumed per leg", () => {
    const { files, filePath } = project(smelly);
    const evidence = buildPromiseCombinatorMismatchEvidence(
      candidateFor(smelly, filePath, "syncProviders"),
      files,
    );

    expect(evidence).toMatchObject({
      function: { name: "syncProviders", exported: true },
      combinators: [{
        combinator: "all",
        heterogeneous: true,
        perLegCapture: false,
        perLegConsumption: true,
      }],
    });
    expect(evidence?.combinators[0]?.legs).toHaveLength(3);
  });

  it("captures race without loser cleanup", () => {
    const source = `export async function firstHealthy(urls: string[]) {
  return Promise.race(urls.map((url) => openConnection(url)));
}
`;
    const { files, filePath } = project(source);
    const evidence = buildPromiseCombinatorMismatchEvidence(
      candidateFor(source, filePath, "firstHealthy"),
      files,
    );

    expect(evidence?.combinators).toMatchObject([{
      combinator: "race",
      resourceLegs: true,
      cleanupPresent: false,
    }]);
  });

  it("marks homogeneous tuple consumption as weakening evidence", () => {
    const { files, filePath } = project(homogeneous);
    const evidence = buildPromiseCombinatorMismatchEvidence(
      candidateFor(homogeneous, filePath, "loadDashboard"),
      files,
    );

    expect(evidence?.combinators).toMatchObject([{
      combinator: "all",
      heterogeneous: false,
      perLegConsumption: true,
    }]);
  });

  it("marks allSettled with status consumption as captured", () => {
    const { files, filePath } = project(settled);
    const evidence = buildPromiseCombinatorMismatchEvidence(
      candidateFor(settled, filePath, "syncProviders"),
      files,
    );

    expect(evidence?.combinators).toMatchObject([{
      combinator: "allSettled",
      perLegCapture: true,
      perLegConsumption: true,
    }]);
  });

  it("abstains when no combinator is used", () => {
    const source = `export async function loadProfile(userId: string) {
  const profile = await fetchProfile(userId);
  return profile;
}
`;
    const { files, filePath } = project(source);
    expect(buildPromiseCombinatorMismatchEvidence(candidateFor(source, filePath, "loadProfile"), files))
      .toBeUndefined();
  });

  it("abstains for sequential awaits with no combinator", () => {
    const source = `export async function loadBoth(userId: string) {
  const profile = await fetchProfile(userId);
  const settings = await fetchSettings(userId);
  return { profile, settings };
}
`;
    const { files, filePath } = project(source);
    expect(buildPromiseCombinatorMismatchEvidence(candidateFor(source, filePath, "loadBoth"), files))
      .toBeUndefined();
  });
});
