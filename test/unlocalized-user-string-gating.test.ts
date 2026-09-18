import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { loadConfig, optInRuleDefaults } from "../src/config.js";
import type {
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const RULE_ID = "jev/no-unlocalized-user-string";

const smelly = `export function CheckoutSummary({ count }: { count: number }) {
  return (
    <div>
      <p>Order complete</p>
      <span>{count === 1 ? "item" : "items"}</span>
    </div>
  );
}
`;

const frameworkIntent: ProjectFile = {
  filePath: "src/i18n.ts",
  source: `import i18next from "i18next";\nexport const locale = i18next.language;\n`,
};

const localeDirIntent: ProjectFile = {
  filePath: "src/locales/en.json",
  source: `{"order.complete": "Order complete"}\n`,
};

const intlUsageIntent: ProjectFile = {
  filePath: "src/money.ts",
  source: `export function formatPrice(value: number) {\n  return new Intl.NumberFormat("en-US").format(value);\n}\n`,
};

function englishOnlyRepo(): ProjectFile[] {
  return [{ filePath: "src/summary.tsx", source: smelly }];
}

function intentRepo(intent: ProjectFile): ProjectFile[] {
  return [{ filePath: "src/summary.tsx", source: smelly }, intent];
}

/** Fake evaluator: returns one fixed raw score per question, records requests. */
class FakeEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];
  constructor(private readonly probability: number) {}
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, this.probability]));
  }
}

function questionsFor(evaluator: FakeEvaluator, ruleId: string): number {
  return evaluator.requests.reduce(
    (total, request) =>
      total +
      Object.values(request.questions).filter(
        (question) => JSON.stringify(question.instructions).includes(ruleId),
      ).length,
    0,
  );
}

async function review(projectFiles: ProjectFile[], config: JevLintConfig, probability: number) {
  const changed = projectFiles[0]!;
  const evaluator = new FakeEvaluator(probability);
  const result = await analyzeFileWithFailures(
    {
      filePath: changed.filePath,
      source: changed.source,
      changedLines: [{ start: 1, end: changed.source.split("\n").length }],
      config,
      projectFiles,
    },
    evaluator,
  );
  return { result, evaluator };
}

function enabledConfig(): JevLintConfig {
  const rule = optInRuleDefaults[RULE_ID];
  expect(rule).toBeDefined();
  return { rules: { [RULE_ID]: rule! } };
}

describe("no-unlocalized-user-string gating", () => {
  it.each([
    ["framework import", frameworkIntent],
    ["locale directory", localeDirIntent],
    ["project Intl usage", intlUsageIntent],
  ])("fires with raw score when intent comes from %s", async (_label, intent) => {
    const { result, evaluator } = await review(intentRepo(intent), enabledConfig(), 0.83);

    expect(questionsFor(evaluator, RULE_ID)).toBeGreaterThan(0);
    const judgments = result.judgments.filter(({ ruleId }) => ruleId === RULE_ID);
    expect(judgments).toHaveLength(1);
    // Raw score, no cutoff: the fake probability passes through untouched.
    expect(judgments[0]?.probability).toBe(0.83);
    expect(result.abstentions.filter(({ ruleId }) => ruleId === RULE_ID)).toEqual([]);
  });

  it("abstains with no probability for an English-only repo", async () => {
    const { result, evaluator } = await review(englishOnlyRepo(), enabledConfig(), 0.83);

    expect(questionsFor(evaluator, RULE_ID)).toBe(0);
    expect(result.judgments.filter(({ ruleId }) => ruleId === RULE_ID)).toEqual([]);
    expect(result.abstentions).toContainEqual({ ruleId: RULE_ID, candidateKind: "function", count: 1 });
  });

  it("asks nothing when the rule is not enabled, even with intent present", async () => {
    const { result, evaluator } = await review(intentRepo(frameworkIntent), { rules: {} }, 0.83);

    expect(questionsFor(evaluator, RULE_ID)).toBe(0);
    expect(result.judgments.filter(({ ruleId }) => ruleId === RULE_ID)).toEqual([]);
    expect(result.abstentions.filter(({ ruleId }) => ruleId === RULE_ID)).toEqual([]);
  });

  it("extracts the smelly candidate so the fixtures above target it", () => {
    const candidate = extractCandidates("src/summary.tsx", smelly).find(
      ({ kind, source }) => kind === "function" && source.includes("CheckoutSummary"),
    );
    expect(candidate).toBeDefined();
  });
});

describe("no-unlocalized-user-string opt-in selection", () => {
  it("is off by default", async () => {
    const config = await loadConfig({ cwd: await mkdtemp(join(tmpdir(), "jevlint-optin-")) });

    expect(config.rules[RULE_ID]).toBeUndefined();
  });

  it("enables with an explicit full entry (the documented opt-in shape)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevlint-optin-"));
    const rule = optInRuleDefaults[RULE_ID];
    expect(rule).toBeDefined();
    await writeFile(
      join(directory, "jevlint.config.ts"),
      `export default { rules: { ${JSON.stringify(RULE_ID)}: ${JSON.stringify(rule)} } };\n`,
    );

    const config = await loadConfig({ cwd: directory });

    expect(config.rules[RULE_ID]).toEqual(rule);
  });

  it("stays off with an explicit off", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevlint-optin-"));
    await writeFile(
      join(directory, "jevlint.config.ts"),
      `export default { rules: { ${JSON.stringify(RULE_ID)}: "off" } };\n`,
    );

    const config = await loadConfig({ cwd: directory });

    expect(config.rules[RULE_ID]).toBeUndefined();
  });

  it("an explicit enable still abstains without intent (selection never overrides the gate)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevlint-optin-"));
    const rule = optInRuleDefaults[RULE_ID];
    await writeFile(
      join(directory, "jevlint.config.ts"),
      `export default { rules: { ${JSON.stringify(RULE_ID)}: ${JSON.stringify(rule)} } };\n`,
    );
    const config = await loadConfig({ cwd: directory });

    const { result, evaluator } = await review(englishOnlyRepo(), config, 0.83);

    expect(questionsFor(evaluator, RULE_ID)).toBe(0);
    expect(result.judgments.filter(({ ruleId }) => ruleId === RULE_ID)).toEqual([]);
    expect(result.abstentions).toContainEqual({ ruleId: RULE_ID, candidateKind: "function", count: 1 });
  });
});
