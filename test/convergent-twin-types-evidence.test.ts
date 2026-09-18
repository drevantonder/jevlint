import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildConvergentTwinTypesEvidence } from "../src/evidence/convergent-twin-types.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const RULE = "jev/no-convergent-twin-types";
const root = new URL("./fixtures/repositories/convergent-twin-smelly/", import.meta.url);
const boundaryRoot = new URL("./fixtures/repositories/convergent-twin-boundary/", import.meta.url);

class FakeEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];

  constructor(private readonly scores: number[]) {}

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    const ids = Object.keys(request.questions);
    return Object.fromEntries(ids.map((id, index) => [
      id,
      this.scores[index] ?? this.scores[0] ?? 0.5,
    ]));
  }
}

function abstractionCandidate(files: ProjectFile[], filePath: string, excerpt: string): Candidate {
  const owner = files.find((file) => file.filePath === filePath);
  expect(owner).toBeDefined();
  if (!owner) throw new Error(`Fixture has no file ${filePath}.`);
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find(({ kind, source }) => kind === "abstraction" && source.includes(excerpt));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error(`Fixture has no abstraction containing ${excerpt}.`);
  return candidate;
}

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

describe("convergent twin types evidence", () => {
  it("pairs the twin shapes, shared fields, and overlapping consumers", async () => {
    const projectFiles = await Promise.all([
      "src/billing.ts",
      "src/reporting.ts",
      "src/dashboard.ts",
    ].map(load));
    const owner = projectFiles.find((file) => file.filePath === "src/billing.ts");
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("BillingInvoice"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildConvergentTwinTypesEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      abstraction: { name: "BillingInvoice" },
      twin: { name: "ReportingInvoice", filePath: "src/reporting.ts" },
      consumers: { sharedImporterFiles: ["src/dashboard.ts"] },
    });
    expect(evidence?.sharedProperties).toHaveLength(8);
    expect(evidence?.propertyJaccard).toBe(1);
  });

  it("abstains for small coincidental shapes with no twin", async () => {
    const distinct = new URL("./fixtures/repositories/convergent-twin-distinct/", import.meta.url);
    const projectFiles = await Promise.all([
      "src/billing.ts",
      "src/reporting.ts",
    ].map(async (filePath): Promise<ProjectFile> => ({
      filePath,
      source: await readFile(new URL(filePath, distinct), "utf8"),
    })));
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ source }) => source.includes("BillingAccount"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildConvergentTwinTypesEvidence(candidate, projectFiles))
      .toBeUndefined();
  });

  it("abstains across a validation boundary with a narrowing step", async () => {
    const projectFiles = await Promise.all([
      "src/wire.ts",
      "src/domain.ts",
      "src/parse.ts",
    ].map(async (filePath): Promise<ProjectFile> => ({
      filePath,
      source: await readFile(new URL(filePath, boundaryRoot), "utf8"),
    })));

    expect(
      buildConvergentTwinTypesEvidence(
        abstractionCandidate(projectFiles, "src/wire.ts", "WireInvoice"),
        projectFiles,
      ),
    ).toBeUndefined();
    expect(
      buildConvergentTwinTypesEvidence(
        abstractionCandidate(projectFiles, "src/domain.ts", "DomainInvoice"),
        projectFiles,
      ),
    ).toBeUndefined();
  });

  it("abstains for a zod-style schema step between wire and domain", () => {
    const projectFiles: ProjectFile[] = [
      {
        filePath: "src/wire.ts",
        source: "export type WireOrder = {\n"
          + "  id: unknown;\n"
          + "  sku: unknown;\n"
          + "  qty: unknown;\n"
          + "  priceCents: unknown;\n"
          + "  currency: unknown;\n"
          + "};\n",
      },
      {
        filePath: "src/domain.ts",
        source: "export type DomainOrder = {\n"
          + "  id: string;\n"
          + "  sku: string;\n"
          + "  qty: number;\n"
          + "  priceCents: number;\n"
          + "  currency: string;\n"
          + "};\n",
      },
      {
        filePath: "src/schema.ts",
        source: "import { z } from \"zod\";\n"
          + "import type { DomainOrder } from \"./domain.js\";\n"
          + "export const DomainOrderSchema = z.object({\n"
          + "  id: z.string(),\n"
          + "  sku: z.string(),\n"
          + "  qty: z.number(),\n"
          + "  priceCents: z.number(),\n"
          + "  currency: z.string(),\n"
          + "});\n"
          + "export function parseOrder(input: unknown): DomainOrder {\n"
          + "  const parsed = DomainOrderSchema.safeParse(input);\n"
          + "  if (!parsed.success) throw new Error(\"bad order\");\n"
          + "  return parsed.data;\n"
          + "}\n",
      },
    ];

    expect(
      buildConvergentTwinTypesEvidence(
        abstractionCandidate(projectFiles, "src/domain.ts", "DomainOrder"),
        projectFiles,
      ),
    ).toBeUndefined();
  });

  it("fires for genuinely converged twins with no boundary", () => {
    const projectFiles: ProjectFile[] = [
      {
        filePath: "src/orders.ts",
        source: "export type OrderLine = {\n"
          + "  id: string;\n"
          + "  sku: string;\n"
          + "  qty: number;\n"
          + "  priceCents: number;\n"
          + "  currency: string;\n"
          + "};\n",
      },
      {
        filePath: "src/returns.ts",
        source: "export type ReturnLine = {\n"
          + "  id: string;\n"
          + "  sku: string;\n"
          + "  qty: number;\n"
          + "  priceCents: number;\n"
          + "  currency: string;\n"
          + "};\n",
      },
    ];

    const evidence = buildConvergentTwinTypesEvidence(
      abstractionCandidate(projectFiles, "src/orders.ts", "OrderLine"),
      projectFiles,
    );
    expect(evidence).toMatchObject({
      abstraction: { name: "OrderLine" },
      twin: { name: "ReturnLine", filePath: "src/returns.ts" },
    });
    expect(evidence?.sharedProperties).toHaveLength(5);
    expect(evidence?.propertyJaccard).toBe(1);
  });

  it("keeps its proposition reframed only for the boundary and reports raw scores", async () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "abstraction",
      question: expect.objectContaining({
        instructions: expect.objectContaining({
          question: "Does this type duplicate a field shape already owned by another module, so the two copies must be kept in agreement by hand?",
        }),
      }),
      message: "This type duplicates a field shape already owned by another module.",
    });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");

    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };

    const boundaryFiles = await Promise.all([
      "src/wire.ts",
      "src/domain.ts",
      "src/parse.ts",
    ].map(async (filePath): Promise<ProjectFile> => ({
      filePath,
      source: await readFile(new URL(filePath, boundaryRoot), "utf8"),
    })));
    const boundarySource = boundaryFiles.find((file) => file.filePath === "src/domain.ts")?.source;
    expect(boundarySource).toBeDefined();
    if (!boundarySource) return;
    const boundaryEvaluator = new FakeEvaluator([0.77]);
    const boundary = await analyzeFileWithFailures({
      filePath: "src/domain.ts",
      source: boundarySource,
      changedLines: [{ start: 1, end: boundarySource.split("\n").length }],
      config,
      projectFiles: boundaryFiles,
    }, boundaryEvaluator);
    expect(boundary.judgments).toEqual([]);
    expect(boundary.abstentions).toEqual([
      { ruleId: RULE, candidateKind: "abstraction", count: 1 },
    ]);
    expect(boundaryEvaluator.requests).toHaveLength(0);

    const twinSource = "export type OrderLine = {\n"
      + "  id: string;\n"
      + "  sku: string;\n"
      + "  qty: number;\n"
      + "  priceCents: number;\n"
      + "  currency: string;\n"
      + "};\n";
    const twinFiles: ProjectFile[] = [
      { filePath: "src/orders.ts", source: twinSource },
      {
        filePath: "src/returns.ts",
        source: twinSource.replaceAll("OrderLine", "ReturnLine"),
      },
    ];
    const hot = new FakeEvaluator([0.82]);
    const hotResult = await analyzeFileWithFailures({
      filePath: "src/orders.ts",
      source: twinSource,
      changedLines: [{ start: 1, end: 7 }],
      config,
      projectFiles: twinFiles,
    }, hot);
    expect(hotResult.judgments.map(({ ruleId }) => ruleId)).toEqual([RULE]);
    expect(hotResult.judgments[0]?.probability).toBe(0.82);
    expect(hotResult.abstentions).toEqual([]);

    const cold = new FakeEvaluator([0.12]);
    const coldResult = await analyzeFileWithFailures({
      filePath: "src/orders.ts",
      source: twinSource,
      changedLines: [{ start: 1, end: 7 }],
      config,
      projectFiles: twinFiles,
    }, cold);
    expect(coldResult.judgments.map(({ ruleId }) => ruleId)).toEqual([RULE]);
    expect(coldResult.judgments[0]?.probability).toBe(0.12);
  });
});
