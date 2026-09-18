import { describe, expect, it } from "vitest";
import { analyzeFile } from "../src/analyze.js";
import { defaultConfig } from "../src/config.js";
import type {
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const RULE_ID = "jev/no-coincidental-similarity";
const MERGEABLE_SCORE = 0.88;
const SEPARATE_SCORE = 0.12;

const rule = defaultConfig.rules[RULE_ID];

const invoiceSource = `export interface Order {
  subtotal: number;
  payment: { fee: number };
}

export function totalInvoice(order: Order): number {
  const tax = order.subtotal * 0.2;
  const fee = order.payment.fee;
  return tax + fee;
}
`;

const payoutSource = `export interface Shift {
  hours: number;
  contract: { rate: number };
}

export function totalPayout(shift: Shift): number {
  const bonus = shift.hours * 0.1;
  const rate = shift.contract.rate;
  return bonus + rate;
}
`;

const mergeableSource = `export interface Order {
  subtotal: number;
  fee: number;
}

export function totalInvoice(order: Order): number {
  const tax = order.subtotal * 0.2;
  const fee = order.fee;
  const total = order.subtotal + tax + fee;
  return total;
}
`;

const mergeableTwinSource = `export interface Bill {
  subtotal: number;
  fee: number;
}

export function totalBill(bill: Bill): number {
  const tax = bill.subtotal * 0.2;
  const fee = bill.fee;
  const total = bill.subtotal + tax + fee;
  return total;
}
`;

type WordingProbe = {
  instructions?: {
    evidence?: string | null;
    question?: { question?: string } | string;
  };
};

type MergeabilityProbe = {
  trigger?: {
    sharedMemberNames?: string[];
    sharedLiteralValues?: string[];
  };
  lookalikes?: Array<{
    candidateOnlyMembers?: string[];
    matchOnlyMembers?: string[];
    candidateOnlyLiterals?: string[];
    matchOnlyLiterals?: string[];
    distinctNameTokens?: string[];
    sameModuleRole?: boolean;
    commonCallerFiles?: string[];
    sharedImportSources?: string[];
  }>;
};

/** Fake evaluator: answers the reframed mergeability question honestly from
 * structural evidence alone, no live Jev calls. Shared-concept signals
 * (common literals, members, callers, imports, same module role) argue for
 * one home; divergence signals (one-side-only members and literals,
 * distinct name tokens, different roles) argue the resemblance is
 * coincidence. Raw scores flow straight into judgments; nothing is
 * filtered, so a legitimately separate pair stays visible at its low
 * score instead of reading as an action item. */
class MergeabilityEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    return Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => {
        // SAFETY: jevlint builds every evaluation question with its own
        // QuestionInstructions record carrying the evidence path, so viewing
        // instructions through the probe type is sound within this suite.
        const instructions = (question as WordingProbe).instructions;
        const match = /candidates\[(\d+)\]/.exec(instructions?.evidence ?? "");
        const candidate = match ? request.state.candidates[Number(match[1])] : undefined;
        // SAFETY: buildCoincidentalSimilarityEvidence emits trigger and
        // lookalikes with the string-array fields probed below, so reading
        // lengths through the probe type is sound within this suite.
        const evidence = (candidate?.evidence?.[RULE_ID] ?? {}) as MergeabilityProbe;
        const lookalike = evidence.lookalikes?.[0];
        const merge =
          (evidence.trigger?.sharedLiteralValues?.length ?? 0) +
          (evidence.trigger?.sharedMemberNames?.length ?? 0) +
          (lookalike?.commonCallerFiles?.length ?? 0) * 2 +
          (lookalike?.sharedImportSources?.length ?? 0) +
          (lookalike?.sameModuleRole === true ? 1 : 0);
        const diverge =
          (lookalike?.candidateOnlyMembers?.length ?? 0) +
          (lookalike?.matchOnlyMembers?.length ?? 0) +
          (lookalike?.candidateOnlyLiterals?.length ?? 0) +
          (lookalike?.matchOnlyLiterals?.length ?? 0) +
          (lookalike?.distinctNameTokens?.length ?? 0) +
          (lookalike?.sameModuleRole === true ? 0 : 1);
        return [id, merge > diverge ? MERGEABLE_SCORE : SEPARATE_SCORE];
      }),
    );
  }
}

function changedLines(source: string) {
  return [{ start: 1, end: source.split("\n").length }];
}

describe("coincidental similarity proposition", () => {
  it("asks the mergeability question and states the consolidation verdict", () => {
    expect(rule).toBeDefined();
    if (!rule) return;
    // SAFETY: bundled rule questions carry an instructions record with the
    // proposition string; the probe read below only inspects that string.
    const wording =
      ((rule.question.instructions as { question?: string }).question ?? "");
    expect(wording).toContain("worth consolidating");
    expect(wording).not.toContain("false abstraction");
    expect(rule.message).toContain("consolidate");
  });
});

describe("coincidental similarity mergeability judgments via fake evaluator", () => {
  it("reports a legitimately separate pair at its raw low score with evidence intact", async () => {
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE_ID]: rule } };
    const projectFiles: ProjectFile[] = [
      { filePath: "src/billing/invoice.ts", source: invoiceSource },
      { filePath: "src/payroll/payout.ts", source: payoutSource },
    ];

    const judgments = await analyzeFile(
      {
        filePath: "src/billing/invoice.ts",
        source: invoiceSource,
        changedLines: changedLines(invoiceSource),
        config,
        projectFiles,
      },
      new MergeabilityEvaluator(),
    );

    expect(judgments).toHaveLength(1);
    // The low score is the honest answer to the reframed question, carried
    // raw: distinct concepts are not worth consolidating, and the judgment
    // stays reported instead of being filtered away.
    expect(judgments).toContainEqual(
      expect.objectContaining({
        ruleId: RULE_ID,
        probability: SEPARATE_SCORE,
        message: rule.message,
        evidence: expect.objectContaining({
          trigger: expect.objectContaining({ sameOpcodeSequence: true }),
          lookalikes: [
            expect.objectContaining({
              functionName: "totalPayout",
              candidateOnlyMembers: expect.arrayContaining(["subtotal", "payment", "fee"]),
              matchOnlyMembers: expect.arrayContaining(["hours", "contract", "rate"]),
              distinctNameTokens: expect.arrayContaining(["invoice", "payout"]),
              sameModuleRole: false,
              commonCallerFiles: [],
            }),
          ],
        }),
      }),
    );
  });

  it("reports a mergeable pair at its raw high score on shared-concept signals", async () => {
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE_ID]: rule } };
    const projectFiles: ProjectFile[] = [
      { filePath: "src/billing/invoice.ts", source: mergeableSource },
      { filePath: "src/billing/summary.ts", source: mergeableTwinSource },
    ];

    const judgments = await analyzeFile(
      {
        filePath: "src/billing/invoice.ts",
        source: mergeableSource,
        changedLines: changedLines(mergeableSource),
        config,
        projectFiles,
      },
      new MergeabilityEvaluator(),
    );

    expect(judgments).toHaveLength(1);
    expect(judgments).toContainEqual(
      expect.objectContaining({
        ruleId: RULE_ID,
        probability: MERGEABLE_SCORE,
        message: rule.message,
        evidence: expect.objectContaining({
          trigger: expect.objectContaining({
            sharedMemberNames: expect.arrayContaining(["subtotal", "fee"]),
            sharedLiteralValues: expect.arrayContaining(["0.2"]),
          }),
          lookalikes: [
            expect.objectContaining({
              functionName: "totalBill",
              sameModuleRole: true,
            }),
          ],
        }),
      }),
    );
  });
});
