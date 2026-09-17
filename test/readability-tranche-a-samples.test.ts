import { describe, expect, it } from "vitest";
import { analyzeFile } from "../src/analyze.js";
import { defaultConfig } from "../src/config.js";
import type { Evaluator, JevLintConfig, ProjectFile } from "../src/types.js";

class FakeEvaluator implements Evaluator {
  async evaluate(): Promise<Record<string, number>> {
    return { q0: 0.9 };
  }
}

const CASES: Array<{ ruleId: string; projectFiles: ProjectFile[]; changed: string }> = [
  {
    ruleId: "jev/no-deceptive-name",
    changed: "src/users.ts",
    projectFiles: [{
      filePath: "src/users.ts",
      source: "export interface User {\n  name: string;\n}\n"
        + "export function firstUser(users: User): User {\n  return users;\n}\n",
    }],
  },
  {
    ruleId: "jev/no-punned-name",
    changed: "src/math.ts",
    projectFiles: [
      {
        filePath: "src/math.ts",
        source: "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
      },
      {
        filePath: "src/members.ts",
        source: "const members = new Set<string>();\n"
          + "export function add(item: string): void {\n  members.add(item);\n}\n",
      },
    ],
  },
  {
    ruleId: "jev/no-cryptic-abbreviation",
    changed: "src/billing.ts",
    projectFiles: [{
      filePath: "src/billing.ts",
      source: "// Computes the user account balance.\n"
        + "export function calcUsrAcctBal(usrAcctBal: number): number {\n  return usrAcctBal;\n}\n",
    }],
  },
  {
    ruleId: "jev/no-negative-boolean-name",
    changed: "src/list.ts",
    projectFiles: [{
      filePath: "src/list.ts",
      source: "export function visibleItems(isNotReady: boolean, items: string[]): string[] {\n"
        + "  if (!isNotReady) {\n    return items;\n  }\n  return [];\n}\n",
    }],
  },
  {
    ruleId: "jev/no-unitless-quantity",
    changed: "src/retry.ts",
    projectFiles: [
      {
        filePath: "src/retry.ts",
        source: "export function scheduleRetry(timeout: number, task: () => void): void {\n"
          + "  setTimeout(task, timeout);\n}\n",
      },
      {
        filePath: "src/boot.ts",
        source: "import { scheduleRetry } from \"./retry.js\";\n"
          + "export function boot(run: () => void): void {\n  scheduleRetry(500, run);\n}\n",
      },
    ],
  },
];

describe("readability tranche A sample judgments", () => {
  it.each(CASES)("$ruleId emits a judgment with evidence", async ({ ruleId, projectFiles, changed }) => {
    const rule = defaultConfig.rules[ruleId];
    expect(rule).toBeDefined();
    if (!rule) return;
    const file = projectFiles.find((entry) => entry.filePath === changed);
    expect(file).toBeDefined();
    if (!file) return;
    const config: JevLintConfig = { rules: { [ruleId]: rule } };
    const judgments = await analyzeFile({
      filePath: file.filePath,
      source: file.source,
      changedLines: [{ start: 1, end: file.source.split("\n").length }],
      config,
      projectFiles,
    }, new FakeEvaluator());
    expect(judgments.length).toBeGreaterThan(0);
    for (const judgment of judgments) {
      // eslint-disable-next-line no-console
      console.log(
        `${judgment.ruleId} p=${judgment.probability} ${judgment.filePath}:${judgment.span.start.line} ${judgment.message} evidence=${JSON.stringify(judgment.evidence)?.slice(0, 160)}`,
      );
    }
  });
});
