import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { analyzeAuditWithFailures } from "../src/analyze.js";
import { countImporterInDegree, planWholeRepoModuleCandidates } from "../src/candidates.js";
import { runCli } from "../src/cli.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
} from "../src/types.js";

const execFile = promisify(execFileCallback);

class CountingEvaluator implements Evaluator {
  calls = 0;

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.calls += 1;
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.73]));
  }
}

const auditConfig: JevLintConfig = {
  rules: {
    "test/function-rule": {
      scope: "function",
      question: { instructions: "Is this a function?" },
      message: "Function found.",
    },
    "test/abstraction-rule": {
      scope: "abstraction",
      question: { instructions: "Is this an abstraction?" },
      message: "Abstraction found.",
    },
    "test/comment-rule": {
      scope: "comment",
      question: { instructions: "Is this a comment?" },
      message: "Comment found.",
    },
    "test/module-rule": {
      scope: "module",
      question: { instructions: "Is this a module?" },
      message: "Module found.",
    },
    "test/change-rule": {
      scope: "change",
      question: { instructions: "Is this a change?" },
      message: "Change found.",
    },
  },
};

const twoFiles = [
  {
    filePath: "src/alpha.ts",
    source: "export function alpha() { return 1; }\n// alpha note\n",
  },
  {
    filePath: "src/beta.ts",
    source: "import { alpha } from \"./alpha.js\";\nexport function beta() { return alpha(); }\n",
  },
];

async function cleanRepository(prefix: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  await execFile("git", ["init", "-q"], { cwd });
  await execFile("git", ["config", "user.name", "Test"], { cwd });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd });
  await writeFile(join(cwd, "src-alpha.ts"), "export function solo() { return 1; }\n");
  await execFile("git", ["add", "."], { cwd });
  await execFile("git", ["commit", "-qm", "initial"], { cwd });
  return cwd;
}

describe("planWholeRepoModuleCandidates", () => {
  it("ranks by importer in-degree descending with path tie-break", () => {
    const candidates = planWholeRepoModuleCandidates(twoFiles);
    expect(candidates.map((candidate) => candidate.filePath)).toEqual([
      "src/alpha.ts",
      "src/beta.ts",
    ]);
    expect(countImporterInDegree(twoFiles).get("src/alpha.ts")).toBe(1);
    expect(countImporterInDegree(twoFiles).get("src/beta.ts")).toBe(0);
  });
});

describe("analyzeAuditWithFailures", () => {
  it("runs to completion uncapped when no limits are given", async () => {
    const evaluator = new CountingEvaluator();
    const result = await analyzeAuditWithFailures(
      { projectFiles: twoFiles, config: auditConfig },
      evaluator,
    );

    expect(result.coverage.maxQuestions).toBeNull();
    expect(result.coverage.evidenceBudgetMs).toBeNull();
    expect(result.coverage.complete).toBe(true);
    expect(result.coverage.filesEnumerated).toBe(2);
    expect(result.coverage.filesScored).toBe(2);
    expect(result.coverage.questionsPrepared).toBe(result.coverage.candidatesEnumerated);
    expect(result.coverage.omittedByKind).toEqual([]);
    expect(result.coverage.omittedByRule).toEqual([]);
    expect(result.judgments).toHaveLength(result.coverage.questionsPrepared);
    expect(result.failures).toEqual([]);
    expect(evaluator.calls).toBeGreaterThan(0);
  });

  it("reports change-scope rules as unscored without synthesizing change candidates", async () => {
    const evaluator = new CountingEvaluator();
    const result = await analyzeAuditWithFailures(
      { projectFiles: twoFiles, config: auditConfig, maxQuestions: 1000 },
      evaluator,
    );

    expect(result.coverage.unscoredRules).toEqual([
      {
        ruleId: "test/change-rule",
        scope: "change",
        reason: "requires-before-after-change-context",
      },
    ]);
    expect(result.judgments.some((judgment) => judgment.candidateKind === "change")).toBe(false);
  });

  it("verifies every bundled change-scope rule abstains without diffs", () => {
    const candidate: Candidate = {
      id: "change_0",
      kind: "change",
      filePath: "src/alpha.ts",
      source: "Whole change across 1 file.",
      start: 0,
      end: 10,
      startLine: 1,
      startColumn: 1,
      endLine: 2,
      endColumn: 1,
    };
    const changeRules = Object.entries(defaultConfig.rules)
      .filter(([, rule]) => rule.scope === "change");
    expect(changeRules.length).toBeGreaterThan(0);
    for (const [ruleId] of changeRules) {
      const outcome = buildRuleEvidence(ruleId, candidate, twoFiles, []);
      expect(outcome.handled ? outcome.evidence : undefined, ruleId).toBeUndefined();
    }
  });

  it("enforces max-questions with deterministic kind-ordered omission accounting", async () => {
    const evaluator = new CountingEvaluator();
    const result = await analyzeAuditWithFailures(
      { projectFiles: twoFiles, config: auditConfig, maxQuestions: 2 },
      evaluator,
    );

    expect(result.coverage.questionsPrepared).toBe(2);
    expect(result.coverage.complete).toBe(false);
    const omittedKinds = result.coverage.omittedByKind.map((entry) => entry.kind);
    expect(omittedKinds).toContain("function");
    const totalOmitted = result.coverage.omittedByRule
      .reduce((total, entry) => total + entry.omitted, 0);
    const abstained = result.abstentions.reduce((total, entry) => total + entry.count, 0);
    expect(totalOmitted).toBeGreaterThan(0);
    expect(result.coverage.questionsPrepared + abstained + totalOmitted).toBeGreaterThan(2);
    const totalPairs = result.coverage.candidatesEnumerated;
    expect(result.coverage.questionsPrepared + abstained + totalOmitted).toBe(totalPairs);
    expect(result.judgments).toHaveLength(2);

    const rerun = await analyzeAuditWithFailures(
      { projectFiles: twoFiles, config: auditConfig, maxQuestions: 2 },
      new CountingEvaluator(),
    );
    expect(rerun.coverage).toEqual(result.coverage);
    expect(rerun.judgments).toEqual(result.judgments);
  });

  it("omits everything when the evidence budget is exhausted immediately", async () => {
    const evaluator = new CountingEvaluator();
    const result = await analyzeAuditWithFailures(
      {
        projectFiles: twoFiles,
        config: auditConfig,
        maxQuestions: 1000,
        evidenceBudgetMs: 0,
      },
      evaluator,
    );

    expect(result.coverage.questionsPrepared).toBe(0);
    expect(result.coverage.questionsAsked).toBe(0);
    expect(result.coverage.filesScored).toBe(0);
    expect(result.coverage.filesOmitted).toBe(2);
    expect(result.coverage.complete).toBe(false);
    expect(result.judgments).toEqual([]);
    expect(evaluator.calls).toBe(0);
  });

  it("counts cost without live calls in dry-run mode", async () => {
    const evaluator = new CountingEvaluator();
    const result = await analyzeAuditWithFailures(
      { projectFiles: twoFiles, config: auditConfig, maxQuestions: 1000, dryRun: true },
      evaluator,
    );

    expect(result.coverage.dryRun).toBe(true);
    expect(result.coverage.questionsPrepared).toBeGreaterThan(0);
    expect(result.coverage.questionsAsked).toBe(0);
    expect(result.coverage.complete).toBe(true);
    expect(result.judgments).toEqual([]);
    expect(evaluator.calls).toBe(0);
  });
});

describe("audit CLI", () => {
  it("surveys a clean tree that review reports as empty", async () => {
    const cwd = await cleanRepository("jevlint-audit-clean-");
    const evaluator = new CountingEvaluator();

    let reviewStdout = "";
    const reviewExit = await runCli(["review", "--format", "json"], {
      cwd,
      evaluator,
      stdout: (text) => {
        reviewStdout += text;
      },
      stderr: () => undefined,
    });
    // SAFETY: runCli only prints the report object produced by createReviewReport.
    const reviewReport = JSON.parse(reviewStdout) as { judgments: unknown[] };
    expect(reviewExit).toBe(0);
    expect(reviewReport.judgments).toEqual([]);

    let auditStdout = "";
    const auditExit = await runCli(
      ["audit", "--format", "json", "--dry-run"],
      {
        cwd,
        evaluator: new CountingEvaluator(),
        stdout: (text) => {
          auditStdout += text;
        },
        stderr: () => undefined,
      },
    );
    // SAFETY: runCli only prints the report object produced by createReviewReport.
    const auditReport = JSON.parse(auditStdout) as {
      coverage: {
        filesEnumerated: number;
        questionsPrepared: number;
        complete: boolean;
        maxQuestions: number | null;
        evidenceBudgetMs: number | null;
        unscoredRules: { ruleId: string; reason: string }[];
      };
    };
    expect(auditExit).toBe(0);
    expect(auditReport.coverage.filesEnumerated).toBe(1);
    expect(auditReport.coverage.questionsPrepared).toBeGreaterThan(0);
    expect(auditReport.coverage.complete).toBe(true);
    expect(auditReport.coverage.maxQuestions).toBeNull();
    expect(auditReport.coverage.evidenceBudgetMs).toBeNull();
    expect(evaluator.calls).toBe(0);
  });

  it("advertises both modes in help", async () => {
    let help = "";
    const helpExit = await runCli(["audit", "--help"], {
      cwd: process.cwd(),
      evaluator: new CountingEvaluator(),
      stdout: (text) => {
        help += text;
      },
      stderr: () => undefined,
    });
    expect(helpExit).toBe(0);
    expect(help).toContain("review");
    expect(help).toContain("audit");
    expect(help).toContain("changed code");
    expect(help).toContain("whole codebase");
  });

  it("extends the text summary with coverage honesty", async () => {
    const cwd = await cleanRepository("jevlint-audit-text-");
    let stdout = "";
    const exitCode = await runCli(["audit", "--max-questions", "1", "--dry-run"], {
      cwd,
      evaluator: new CountingEvaluator(),
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => undefined,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("coverage incomplete");
    expect(stdout).toContain("unscored without change context");
  });
});
