import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDivergentSiblingInterfacesEvidence } from "../src/evidence/divergent-sibling-interfaces.js";
import type { ProjectFile } from "../src/types.js";

const smellyRoot = new URL("./fixtures/repositories/divergent-sibling-interfaces-smelly/", import.meta.url);
const cohesiveRoot = new URL(
  "./fixtures/repositories/divergent-sibling-interfaces-cohesive/",
  import.meta.url,
);

async function load(root: URL, filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

async function project(root: URL, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map((filePath) => load(root, filePath)));
}

function classCandidate(owner: ProjectFile) {
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find(({ kind }) => kind === "abstraction");
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("divergent sibling interfaces evidence", () => {
  it("pairs same-arity members with different names across heritage siblings", async () => {
    const projectFiles = await project(smellyRoot, [
      "src/notifier-base.ts",
      "src/email-notifier.ts",
      "src/sms-notifier.ts",
      "src/push-notifier.ts",
      "src/notify.ts",
    ]);
    const owner = projectFiles.find(({ filePath }) => filePath === "src/email-notifier.ts")!;
    const evidence = buildDivergentSiblingInterfacesEvidence(classCandidate(owner), projectFiles);

    expect(evidence).toMatchObject({
      class: { name: "EmailNotifier" },
      relationship: { kind: "superclass", reference: "extends NotifierBase" },
      siblings: expect.arrayContaining([
        expect.objectContaining({ name: "SmsNotifier" }),
        expect.objectContaining({ name: "PushNotifier" }),
      ]),
      analogousPairs: expect.arrayContaining([
        expect.objectContaining({
          candidateMember: "sendEmail",
          sibling: "SmsNotifier",
          siblingMember: "deliverSms",
          sameArity: true,
        }),
      ]),
      sharedClients: [expect.objectContaining({ filePath: "src/notify.ts" })],
    });
    expect(evidence?.sharedClients[0]?.siblingCalls.length).toBeGreaterThan(0);
  });

  it("reports arity differences when sibling names agree", async () => {
    const projectFiles = await project(cohesiveRoot, [
      "src/notifier-base.ts",
      "src/email-notifier.ts",
      "src/sms-notifier.ts",
    ]);
    const owner = projectFiles.find(({ filePath }) => filePath === "src/email-notifier.ts")!;
    const evidence = buildDivergentSiblingInterfacesEvidence(classCandidate(owner), projectFiles);

    expect(evidence?.analogousPairs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          candidateMember: "send",
          sibling: "SmsNotifier",
          siblingMember: "send",
          sameArity: false,
        }),
      ]),
    );
  });

  it("abstains without siblings or without members", () => {
    const solo = "export class Solo { run(): void {} }";
    const candidate = extractCandidates("src/solo.ts", solo)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(buildDivergentSiblingInterfacesEvidence(candidate, [{ filePath: "src/solo.ts", source: solo }]))
      .toBeUndefined();
  });
});
