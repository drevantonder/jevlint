import { describe, expect, it } from "vitest";
import { analyzeFile } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { buildInlineLifecyclePhasesEvidence } from "../src/evidence/inline-lifecycle-phases.js";
import type {
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const smellySource = `import { pool } from "./db.js";

export async function confirmOrders(raw: string): Promise<string> {
  const rows = raw.split("\\n");
  const orders = rows.map((row) => row.split(","));
  for (const order of orders) {
    await pool.query("INSERT INTO orders VALUES ($1)", [order[0]]);
  }
  const body = orders.map((order) => "<li>" + order[0] + "</li>").join("");
  return "<ul>" + body + "</ul>";
}
`;

const sandwichSource = `import { priceOrder } from "./pricing.js";

export function handleCheckout(body: { items: number[] }): string {
  const { items } = body;
  const total = priceOrder(items);
  return JSON.stringify({ total });
}
`;

const singlePhaseSource = `export function total(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0);
}
`;

function candidateFor(source: string, filePath: string) {
  return extractCandidates(filePath, source).find(({ kind }) => kind === "function");
}

describe("inline lifecycle phases evidence", () => {
  it("extracts inline parse, compute, effect, and present regions", () => {
    const files: ProjectFile[] = [{ filePath: "src/orders.ts", source: smellySource }];
    const candidate = candidateFor(smellySource, "src/orders.ts");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildInlineLifecyclePhasesEvidence(candidate, files);

    expect(evidence).toMatchObject({
      function: { name: "confirmOrders", filePath: "src/orders.ts" },
      phases: ["effect", "present", "parse", "compute"],
      importSources: ["./db.js"],
    });
    expect(evidence?.regions.length).toBeGreaterThanOrEqual(4);
    expect(evidence?.sharedBindings).toEqual(expect.arrayContaining(["rows", "orders"]));
    expect(evidence?.collaborators).toEqual([
      expect.objectContaining({ phase: "effect", importedFrom: "./db.js" }),
    ]);
    expect(evidence?.phaseHelpers).toEqual([]);
  });

  it("surfaces the use-case collaborator seam in a boundary sandwich", () => {
    const files: ProjectFile[] = [{ filePath: "src/checkout.ts", source: sandwichSource }];
    const candidate = candidateFor(sandwichSource, "src/checkout.ts");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildInlineLifecyclePhasesEvidence(candidate, files);

    expect(evidence?.phases).toEqual(expect.arrayContaining(["parse", "compute", "present"]));
    expect(evidence?.collaborators).toEqual([
      expect.objectContaining({ phase: "compute", importedFrom: "./pricing.js" }),
    ]);
  });

  it("abstains when the body covers a single phase", () => {
    const files: ProjectFile[] = [{ filePath: "src/total.ts", source: singlePhaseSource }];
    const candidate = candidateFor(singlePhaseSource, "src/total.ts");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildInlineLifecyclePhasesEvidence(candidate, files)).toBeUndefined();
  });
});

const orchestratorSource = `import { validate } from "./parse.js";
import { shardWork } from "./shard.js";
import { persist } from "./store.js";
import { formatSummary } from "./present.js";

export function runPipeline(raw: string): string {
  const input = validate(raw);
  const shards = shardWork(input);
  const saved = persist(shards);
  return formatSummary(saved);
}
`;

type DelegationProbe = {
  instructions?: {
    evidence?: string | null;
  };
};

type LifecycleEvidenceProbe = {
  delegation?: {
    delegatedLines?: number[];
    inlineLines?: number[];
    finishedOrchestrator?: boolean;
  };
};

/** Fake evaluator: scores from delegation facts alone, no live Jev calls.
 * Evidence travels under request.state.candidates[i].evidence[ruleId]; the
 * raw score for each question comes from its own candidate's evidence.
 * Scores flow straight into judgments; nothing is cut off. */
class DelegationScoringEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    return Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => {
        // SAFETY: jevlint builds every evaluation question with its own
        // QuestionInstructions record carrying the evidence path, so viewing
        // instructions through the probe type is sound within this suite.
        const instructions = (question as DelegationProbe).instructions;
        const match = /candidates\[(\d+)\]/.exec(instructions?.evidence ?? "");
        const candidate = match ? request.state.candidates[Number(match[1])] : undefined;
        // SAFETY: buildInlineLifecyclePhasesEvidence emits delegation as an
        // object with delegated/inline line arrays, and Array.isArray below
        // admits only genuine arrays.
        const evidence = (candidate?.evidence?.["jev/no-inline-lifecycle-phases"] ?? {}) as LifecycleEvidenceProbe;
        const delegation = evidence.delegation;
        const inlineCount = Array.isArray(delegation?.inlineLines) ? delegation.inlineLines.length : 0;
        const orchestrator = delegation?.finishedOrchestrator === true;
        return [id, orchestrator ? 0.18 : inlineCount > 0 ? 0.85 : 0.14];
      }),
    );
  }
}

const delegationConfig: JevLintConfig = {
  rules: {
    "jev/no-inline-lifecycle-phases": {
      scope: "function",
      question: { instructions: "Do genuinely-inline phase regions lack named seams?" },
      message: "Inline lifecycle phases.",
    },
  },
};

function changedLines(source: string) {
  return [{ start: 1, end: source.split("\n").length }];
}

describe("inline lifecycle phases delegation", () => {
  it("names every region delegated in an orchestrator of named steps", () => {
    const files: ProjectFile[] = [{ filePath: "src/pipeline.ts", source: orchestratorSource }];
    const candidate = candidateFor(orchestratorSource, "src/pipeline.ts");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildInlineLifecyclePhasesEvidence(candidate, files);

    expect(evidence?.phases).toEqual(expect.arrayContaining(["parse", "compute", "effect", "present"]));
    expect(evidence?.regions.length).toBeGreaterThanOrEqual(4);
    expect(evidence?.regions.every((region) => region.delegated)).toBe(true);
    expect(evidence?.regions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ phase: "parse", delegated: true, delegates: ["validate"] }),
        expect.objectContaining({ phase: "compute", delegated: true, delegates: ["shardWork"] }),
        expect.objectContaining({ phase: "effect", delegated: true, delegates: ["persist"] }),
        expect.objectContaining({ phase: "present", delegated: true, delegates: ["formatSummary"] }),
      ]),
    );
    expect(evidence?.delegation).toMatchObject({
      inlineLines: [],
      finishedOrchestrator: true,
    });
    expect(evidence?.delegation.delegatedLines.length).toBe(evidence?.regions.length);
  });

  it("names genuinely-inline regions in a body that does the work itself", () => {
    const files: ProjectFile[] = [{ filePath: "src/orders.ts", source: smellySource }];
    const candidate = candidateFor(smellySource, "src/orders.ts");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildInlineLifecyclePhasesEvidence(candidate, files);

    expect(evidence?.delegation.finishedOrchestrator).toBe(false);
    expect(evidence?.delegation.delegatedLines).toEqual([]);
    expect(evidence?.delegation.inlineLines.length).toBeGreaterThanOrEqual(4);
    expect(evidence?.regions.every((region) => !region.delegated && region.delegates.length === 0)).toBe(true);
  });
});

describe("inline lifecycle phases judgments via fake evaluator", () => {
  it("carries raw fake scores into judgments with no cutoff", async () => {
    const orchestratorFiles: ProjectFile[] = [{ filePath: "src/pipeline.ts", source: orchestratorSource }];
    const smellyFiles: ProjectFile[] = [{ filePath: "src/orders.ts", source: smellySource }];
    const evaluator = new DelegationScoringEvaluator();

    const [orchestratorJudgments, smellyJudgments] = await Promise.all([
      analyzeFile(
        {
          filePath: "src/pipeline.ts",
          source: orchestratorSource,
          changedLines: changedLines(orchestratorSource),
          config: delegationConfig,
          projectFiles: orchestratorFiles,
        },
        evaluator,
      ),
      analyzeFile(
        {
          filePath: "src/orders.ts",
          source: smellySource,
          changedLines: changedLines(smellySource),
          config: delegationConfig,
          projectFiles: smellyFiles,
        },
        evaluator,
      ),
    ]);

    const orchestratorHit = orchestratorJudgments.find(({ probability }) => probability === 0.18);
    expect(orchestratorHit).toMatchObject({
      ruleId: "jev/no-inline-lifecycle-phases",
      probability: 0.18,
      evidence: expect.objectContaining({
        delegation: expect.objectContaining({ finishedOrchestrator: true }),
      }),
    });

    const smellyHit = smellyJudgments.find(({ probability }) => probability === 0.85);
    expect(smellyHit).toMatchObject({
      ruleId: "jev/no-inline-lifecycle-phases",
      probability: 0.85,
      evidence: expect.objectContaining({
        delegation: expect.objectContaining({ finishedOrchestrator: false }),
      }),
    });

    // Low-evidence judgments are still reported with their raw score: no cutoffs.
    expect(orchestratorJudgments).toContainEqual(
      expect.objectContaining({
        ruleId: "jev/no-inline-lifecycle-phases",
        probability: 0.18,
      }),
    );
  });
});
