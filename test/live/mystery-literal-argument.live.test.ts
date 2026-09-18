import { describe, expect, it } from "vitest";
import { analyzeChanges } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { Evaluator, JevLintConfig, ProjectFile, SourceFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator: Evaluator = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });

const CALLEE = `export function render(data: string, mode: string): string {
  if (mode === "compact") {
    return data.slice(0, 10);
  }
  if (mode === "full") {
    return data;
  }
  return data.trim();
}
`;

const SMELLY_CALLER = `import { render } from "./render.js";

export function preview(data: string): string {
  return render(data, "compact");
}
`;

const CLEAN_CALLER = `import { render } from "./render.js";

export function preview(data: string, mode: string): string {
  return render(data, mode);
}
`;

function change(filePath: string, source: string): SourceFile {
  return {
    filePath,
    source,
    oldSource: source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
  };
}

async function lint(files: SourceFile[]) {
  const rule = defaultConfig.rules["jev/no-mystery-literal-argument"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-mystery-literal-argument": rule } };
  const projectFiles: ProjectFile[] = files.map(({ filePath, source }) => ({ filePath, source }));
  return analyzeChanges({ changes: files, config, projectFiles }, evaluator);
}

liveDescribe("mystery literal argument with whole-change evidence", () => {
  it("judges a behavior-selecting literal but abstains without one", async () => {
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([change("src/render.ts", CALLEE), change("src/page.ts", SMELLY_CALLER)]),
      lint([change("src/render.ts", CALLEE), change("src/page.ts", CLEAN_CALLER)]),
    ]);

    expect(smellyJudgments).toHaveLength(1);
    expect(smellyJudgments[0]?.probability).toBeGreaterThanOrEqual(0);
    expect(smellyJudgments[0]?.probability).toBeLessThanOrEqual(1);
    expect(cleanJudgments).toHaveLength(0);
  });
});
