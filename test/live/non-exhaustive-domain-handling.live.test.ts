import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import type { Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator: Evaluator = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

const SMELLY: ProjectFile = {
  filePath: "src/order.ts",
  source: "export type Status = \"paid\" | \"shipped\" | \"refunded\";\n"
    + "export function price(status: Status): number {\n"
    + "  switch (status) {\n"
    + "    case \"paid\":\n"
    + "      return 100;\n"
    + "    case \"shipped\":\n"
    + "      return 50;\n"
    + "  }\n"
    + "}\n",
};
const CLEAN: ProjectFile = {
  filePath: "src/order.ts",
  source: "export type Status = \"paid\" | \"shipped\" | \"refunded\";\n"
    + "export function price(status: Status): number {\n"
    + "  switch (status) {\n"
    + "    case \"paid\":\n"
    + "      return 100;\n"
    + "    case \"shipped\":\n"
    + "      return 50;\n"
    + "    default:\n"
    + "      return 0;\n"
    + "  }\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[]) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/order.ts");
  const rule = defaultConfig.rules["jev/no-non-exhaustive-domain-handling"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-non-exhaustive-domain-handling": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("non-exhaustive domain handling with structural evidence", () => {
  it("judges a switch with a silently missing member but abstains with a default", async () => {
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY]),
      lint([CLEAN]),
    ]);

    expect(smellyJudgments).toHaveLength(1);
    expect(smellyJudgments[0]?.probability).toBeGreaterThanOrEqual(0);
    expect(smellyJudgments[0]?.probability).toBeLessThanOrEqual(1);
    expect(cleanJudgments).toHaveLength(0);
  });
});
