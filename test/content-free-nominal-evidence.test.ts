import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildContentFreeNominalEvidence } from "../src/evidence/content-free-nominal.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const RULE = "jev/no-content-free-nominal";
const smellyRoot = new URL("./fixtures/repositories/content-free-nominal-smelly/", import.meta.url);
const cleanRoot = new URL("./fixtures/repositories/content-free-nominal-clean/", import.meta.url);

async function load(base: URL, filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, base), "utf8") };
}

function abstractionFor(source: string, filePath: string, snippet: string): Candidate {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "abstraction" && text.includes(snippet));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error(`Fixture has no abstraction containing ${snippet}.`);
  return candidate;
}

describe("content free nominal evidence", () => {
  it("keeps its proposition while gaining a builder", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "abstraction",
      question: expect.objectContaining({
        instructions: expect.objectContaining({
          question: "Does this class or type name end in a content-free nominal that promises no domain role while its members span unrelated responsibilities?",
        }),
      }),
      message: "This class or type name promises no domain role while its members span unrelated responsibilities.",
    });
  });

  it("extracts disjoint member groups behind a Manager suffix", async () => {
    const files = await Promise.all([
      load(smellyRoot, "src/user-manager.ts"),
      load(smellyRoot, "src/order-info.ts"),
    ]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;

    const result = buildRuleEvidence(
      RULE,
      abstractionFor(owner.source, owner.filePath, "class UserManager"),
      files,
    );

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
    if (!result.handled) return;
    expect(result.evidence).toMatchObject({
      abstraction: { name: "UserManager", kind: "class", suffix: "Manager" },
      members: {
        fields: ["users", "newsletterSubscribers", "payrollLedger"],
        methods: expect.arrayContaining([
          expect.objectContaining({ name: "createUser", touches: ["users"] }),
          expect.objectContaining({ name: "sendNewsletter", touches: ["newsletterSubscribers"] }),
          expect.objectContaining({ name: "totalPayroll", touches: ["payrollLedger"] }),
        ]),
        bodiesAvailable: true,
      },
      cohesion: {
        methodCount: 6,
        fieldCount: 3,
        sharedFields: ["newsletterSubscribers", "payrollLedger", "users"],
      },
    });
    // SAFETY: The dispatch contract returns this builder's cohesion object for this rule.
    const cohesion = (result.evidence as { cohesion: { isolatedMethods: string[] } }).cohesion;
    expect(cohesion.isolatedMethods).toEqual([]);
  });

  it("fires on an Info-suffixed interface with signature-only members", async () => {
    const owner = await load(smellyRoot, "src/order-info.ts");

    const evidence = buildContentFreeNominalEvidence(
      abstractionFor(owner.source, owner.filePath, "interface OrderInfo"),
      [owner],
    );

    expect(evidence).toMatchObject({
      abstraction: { name: "OrderInfo", kind: "interface", suffix: "Info" },
      members: {
        fields: expect.arrayContaining(["orderId", "taxJurisdiction"]),
        methods: expect.arrayContaining([
          expect.objectContaining({ name: "fetchTracking", signatureOnly: true }),
        ]),
        bodiesAvailable: false,
      },
    });
  });

  it("fires on a Data-suffixed type alias", () => {
    const source = "export type CacheData = {\n"
      + "  hits: number;\n"
      + "  misses: number;\n"
      + "  reset(): void;\n"
      + "};\n";
    const files: ProjectFile[] = [{ filePath: "src/cache.ts", source }];

    const evidence = buildContentFreeNominalEvidence(
      abstractionFor(source, "src/cache.ts", "type CacheData"),
      files,
    );

    expect(evidence).toMatchObject({
      abstraction: { name: "CacheData", kind: "type", suffix: "Data" },
      members: {
        fields: ["hits", "misses"],
        bodiesAvailable: false,
      },
    });
  });

  it("abstains where the terminal word carries domain meaning", async () => {
    const [repository, service, empty] = await Promise.all([
      load(cleanRoot, "src/user-repository.ts"),
      load(cleanRoot, "src/order-service.ts"),
      load(cleanRoot, "src/empty-manager.ts"),
    ]);
    expect(repository).toBeDefined();
    expect(service).toBeDefined();
    expect(empty).toBeDefined();
    if (!repository || !service || !empty) return;

    expect(buildContentFreeNominalEvidence(
      abstractionFor(repository.source, repository.filePath, "class UserRepository"),
      [repository],
    )).toBeUndefined();
    // Service is deliberately outside the closed suffix list.
    expect(buildContentFreeNominalEvidence(
      abstractionFor(service.source, service.filePath, "class OrderService"),
      [service],
    )).toBeUndefined();
    // Memberless declarations offer no cohesion to assess.
    expect(buildContentFreeNominalEvidence(
      abstractionFor(empty.source, empty.filePath, "class EmptyManager"),
      [empty],
    )).toBeUndefined();
  });

  it("abstains for one-token names, anonymous classes, and non-abstractions", () => {
    const metadata = "export class Metadata {\n  version = \"1\";\n}\n";
    const anonymous = "export default class {\n  version = \"1\";\n}\n";
    const fn = "export function manage(users: string[]): number {\n  return users.length;\n}\n";

    expect(buildContentFreeNominalEvidence(
      abstractionFor(metadata, "src/meta.ts", "class Metadata"),
      [{ filePath: "src/meta.ts", source: metadata }],
    )).toBeUndefined();
    expect(buildContentFreeNominalEvidence(
      abstractionFor(anonymous, "src/anon.ts", "version"),
      [{ filePath: "src/anon.ts", source: anonymous }],
    )).toBeUndefined();

    const functionCandidate = extractCandidates("src/manage.ts", fn)
      .find(({ kind }) => kind === "function");
    expect(functionCandidate).toBeDefined();
    if (!functionCandidate) return;
    expect(buildContentFreeNominalEvidence(functionCandidate, [
      { filePath: "src/manage.ts", source: fn },
    ])).toBeUndefined();
  });

  it("carries suffix and member evidence through a fake evaluator with raw scores", async () => {
    const owner = await load(smellyRoot, "src/user-manager.ts");
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    let seen: EvaluationRequest | undefined;
    const evaluator: Evaluator = {
      async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
        seen = request;
        return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.83]));
      },
    };

    const result = await analyzeFileWithFailures({
      filePath: owner.filePath,
      source: owner.source,
      changedLines: [{ start: 1, end: owner.source.split("\n").length }],
      config,
      projectFiles: [owner],
    }, evaluator);

    expect(result.failures).toEqual([]);
    expect(result.judgments.map((judgment) => judgment.probability)).toEqual([0.83]);
    const [judgment] = result.judgments;
    expect(judgment?.ruleId).toBe(RULE);
    // SAFETY: rule evidence is a JSON object and this builder always sets the abstraction section.
    const evidence = judgment?.evidence as {
      abstraction?: { name?: string; suffix?: string };
      members?: { methods?: { name?: string }[] };
    } | null;
    expect(evidence?.abstraction?.name).toBe("UserManager");
    expect(evidence?.abstraction?.suffix).toBe("Manager");
    expect(evidence?.members?.methods?.map(({ name }) => name)).toContain("totalPayroll");
    expect(seen).toBeDefined();
    expect(Object.keys(seen?.questions ?? {})).toHaveLength(1);
  });

  it("abstains end to end for names outside the suffix list", async () => {
    const owner = await load(cleanRoot, "src/user-repository.ts");
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const evaluator: Evaluator = {
      async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
        return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.83]));
      },
    };

    const result = await analyzeFileWithFailures({
      filePath: owner.filePath,
      source: owner.source,
      changedLines: [{ start: 1, end: owner.source.split("\n").length }],
      config,
      projectFiles: [owner],
    }, evaluator);

    expect(result.failures).toEqual([]);
    expect(result.judgments).toEqual([]);
    expect(result.abstentions).toEqual([
      { ruleId: RULE, candidateKind: "abstraction", count: 1 },
    ]);
  });
});
