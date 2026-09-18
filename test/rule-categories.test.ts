import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures, sortJudgments } from "../src/analyze.js";
import {
  RULE_CATEGORIES,
  categoryRank,
  isRuleCategory,
} from "../src/categories.js";
import { defaultConfig, loadConfig, optInRuleDefaults } from "../src/config.js";
import {
  createReviewReport,
  formatGithub,
  formatJson,
  formatText,
} from "../src/format.js";
import type {
  EvaluationRequest,
  Evaluator,
  Judgment,
  JevLintConfig,
  ReviewReport,
} from "../src/types.js";

function judgment(
  ruleId: string,
  probability: number,
  category: Judgment["category"],
  line = 1,
): Judgment {
  return {
    ruleId,
    message: `${ruleId} proposition`,
    probability,
    category,
    filePath: "src/a.ts",
    span: {
      start: { line, column: 1 },
      end: { line, column: 2 },
    },
    candidateKind: "function",
    evidence: null,
  };
}

class FixedEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.8]));
  }
}

function configRules(category: Judgment["category"]): JevLintConfig {
  return {
    rules: {
      "test/probe": {
        scope: "function",
        category,
        question: { instructions: "Is this a probe?" },
        message: "Probe found.",
      },
    },
  };
}

describe("rule categories", () => {
  it("ranks security before correctness before reliability before performance before maintainability before style", () => {
    expect([...RULE_CATEGORIES]).toEqual([
      "security",
      "correctness",
      "reliability",
      "performance",
      "maintainability",
      "style",
    ]);
    const ranks = RULE_CATEGORIES.map(categoryRank);
    expect(ranks).toEqual([...ranks].sort((left, right) => left - right));
    expect(new Set(RULE_CATEGORIES).size).toBe(RULE_CATEGORIES.length);
  });

  it("carries a known category on every bundled rule", () => {
    const entries = [...Object.entries(defaultConfig.rules), ...Object.entries(optInRuleDefaults)];
    expect(entries.length).toBeGreaterThan(300);
    for (const [ruleId, rule] of entries) {
      expect(isRuleCategory(rule.category), ruleId).toBe(true);
    }
    const counts = new Map<string, number>();
    for (const rule of [...Object.values(defaultConfig.rules), ...Object.values(optInRuleDefaults)]) {
      counts.set(rule.category, (counts.get(rule.category) ?? 0) + 1);
    }
    expect(Object.fromEntries(counts)).toEqual({
      security: 16,
      correctness: 58,
      reliability: 42,
      performance: 8,
      maintainability: 167,
      style: 28,
    });
  });

  it("orders judgments by category rank first and probability second", () => {
    const judgments = [
      judgment("test/style-high", 0.95, "style", 1),
      judgment("test/security-low", 0.5, "security", 2),
      judgment("test/correctness-mid", 0.75, "correctness", 3),
      judgment("test/correctness-high", 0.9, "correctness", 4),
    ];

    const sorted = sortJudgments(judgments);

    expect(sorted.map(({ ruleId }) => ruleId)).toEqual([
      "test/security-low",
      "test/correctness-high",
      "test/correctness-mid",
      "test/style-high",
    ]);
    // Probabilities keep their meaning: ordering never rewrites a score.
    expect(sorted.map(({ probability }) => probability)).toEqual([0.5, 0.9, 0.75, 0.95]);
  });

  it("renders text and JSON in category order with the category visible", () => {
    const report = createReviewReport({
      judgments: [
        judgment("test/style-high", 0.95, "style", 1),
        judgment("test/security-low", 0.5, "security", 2),
      ],
      abstentions: [],
      failures: [],
      statistics: { requests: 1, questions: 2 },
    });

    expect(report.judgments.map(({ ruleId }) => ruleId)).toEqual([
      "test/security-low",
      "test/style-high",
    ]);
    const text = formatText(report);
    expect(text.indexOf("test/security-low")).toBeLessThan(text.indexOf("test/style-high"));
    expect(text).toContain("function  security  test/security-low");
    expect(text).toContain("function  style  test/style-high");
    // SAFETY: formatJson serializes the report object produced by createReviewReport.
    const parsed = JSON.parse(formatJson(report)) as ReviewReport;
    expect(parsed.judgments.map(({ ruleId }) => ruleId)).toEqual([
      "test/security-low",
      "test/style-high",
    ]);
    expect(parsed.judgments.map(({ category }) => category)).toEqual([
      "security",
      "style",
    ]);
    expect(formatGithub(report)).toContain("category=security");
    expect(formatGithub(report)).toContain("category=style");
  });

  it("rejects an unknown category in a user rule override", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevlint-category-"));
    await writeFile(
      join(directory, "jevlint.config.ts"),
      `export default {\n`
      + `  rules: {\n`
      + `    "jev/no-narrating-comment": {\n`
      + `      scope: "comment",\n`
      + `      category: "urgent",\n`
      + `      question: { instructions: "Is this urgent?" },\n`
      + `      message: "Urgent.",\n`
      + `    },\n`
      + `  },\n`
      + `};\n`,
    );

    await expect(loadConfig({ cwd: directory })).rejects.toThrow();
  });

  it("keeps the bundled category when a user override omits it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevlint-category-"));
    await writeFile(
      join(directory, "jevlint.config.ts"),
      `export default {\n`
      + `  rules: {\n`
      + `    "jev/no-narrating-comment": {\n`
      + `      scope: "comment",\n`
      + `      question: { instructions: "Reshaped?" },\n`
      + `      message: "Reshaped.",\n`
      + `    },\n`
      + `  },\n`
      + `};\n`,
    );

    const config = await loadConfig({ cwd: directory });

    expect(config.rules["jev/no-narrating-comment"]).toMatchObject({ category: "style" });
  });

  it("rejects custom descriptors with a missing or unknown category", async () => {
    async function loadPlugin(ruleBody: string): Promise<void> {
      const directory = await mkdtemp(join(tmpdir(), "jevlint-category-"));
      await writeFile(join(directory, "rule.ts"), ruleBody);
      await writeFile(
        join(directory, "jevlint.config.ts"),
        `export default {\n  plugins: [{ name: "acme", specifier: "./rule.ts" }],\n};\n`,
      );
      await loadConfig({ cwd: directory });
    }

    await expect(loadPlugin(
      `export default { rules: { "no-cat": {\n`
      + `  name: "no-cat", scope: "comment",\n`
      + `  question: { instructions: "Cat?" }, message: "Cat.",\n`
      + `  buildEvidence: () => ({}),\n} } };\n`,
    )).rejects.toThrow(
      'jevlint: plugin "acme" rule "no-cat": category must be one of security, correctness, reliability, performance, maintainability, style.',
    );
    await expect(loadPlugin(
      `export default { rules: { "no-cat": {\n`
      + `  name: "no-cat", scope: "comment", category: "urgent",\n`
      + `  question: { instructions: "Cat?" }, message: "Cat.",\n`
      + `  buildEvidence: () => ({}),\n} } };\n`,
    )).rejects.toThrow(
      'jevlint: plugin "acme" rule "no-cat": category must be one of security, correctness, reliability, performance, maintainability, style.',
    );
  });

  it("rides judgments as metadata without entering propositions or evidence", async () => {
    const evaluator = new FixedEvaluator();
    const result = await analyzeFileWithFailures(
      {
        filePath: "src/a.ts",
        source: "export function probe() { return 1; }\n",
        changedLines: [{ start: 1, end: 1 }],
        config: configRules("reliability"),
      },
      evaluator,
    );

    expect(result.judgments).toHaveLength(1);
    expect(result.judgments[0]).toMatchObject({
      ruleId: "test/probe",
      probability: 0.8,
      category: "reliability",
    });
    expect(evaluator.requests).toHaveLength(1);
    // The probe rule's own text names no category, so any occurrence would
    // mean metadata leaked into the evaluation payload.
    const serialized = JSON.stringify(evaluator.requests[0]);
    expect(serialized).not.toContain("category");
    expect(serialized).not.toContain("severity");
  });
});
