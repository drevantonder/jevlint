import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator = new TypeSafeEvaluator();

const reportSource = `export interface User {
  name: string;
  email: string;
}

export function renderUser(user: User, detailed: boolean): string {
  if (detailed) {
    const header = "Name: " + user.name;
    const contact = "Email: " + user.email;
    return header + "\\n" + contact;
  }
  return "Name: " + user.name;
}
`;

const pageSource = `import { renderUser } from "./report.js";
import type { User } from "./report.js";

export function summaryPage(user: User): string {
  return renderUser(user, false);
}

export function detailPage(user: User): string {
  return renderUser(user, true);
}
`;

const greetSource = `export function greet(name: string): string {
  return "hello " + name;
}
`;

async function lint(source: string, projectFiles: ProjectFile[]) {
  const rule = defaultConfig.rules["jev/no-mode-flag-parameter"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-mode-flag-parameter": rule } };
  return analyzeFile({
    filePath: "src/report.ts",
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("mode flag parameter with structural evidence", () => {
  it("judges a behavior-selecting flag but abstains without one", async () => {
    const smelly: ProjectFile[] = [
      { filePath: "src/report.ts", source: reportSource },
      { filePath: "src/page.ts", source: pageSource },
    ];
    const clean: ProjectFile[] = [{ filePath: "src/report.ts", source: greetSource }];

    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(reportSource, smelly),
      lint(greetSource, clean),
    ]);

    expect(smellyJudgments).toHaveLength(1);
    expect(smellyJudgments[0]?.probability).toBeGreaterThanOrEqual(0);
    expect(smellyJudgments[0]?.probability).toBeLessThanOrEqual(1);
    expect(cleanJudgments).toHaveLength(0);
  });
});
