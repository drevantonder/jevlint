import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;
const evaluator = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });

const mirroredSource = `import { useEffect, useState } from "react";

export function ItemList({ items }: { items: string[] }): string[] {
  const [local, setLocal] = useState(items);
  useEffect(() => {
    setLocal(items);
  }, [items]);
  const remove = (id: string): void => {
    setLocal(local.filter((item) => item !== id));
  };
  return local;
}
`;

const plainSource = `export function total(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0);
}
`;

async function lint(source: string, projectFiles: ProjectFile[]) {
  const rule = defaultConfig.rules["jev/no-mirrored-derived-state"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-mirrored-derived-state": rule } };
  return analyzeFile({
    filePath: "src/list.ts",
    source,
    changedLines: [{ start: 1, end: source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("mirrored derived state with structural evidence", () => {
  it("judges an effect sync but abstains without a sync shape", async () => {
    const smelly: ProjectFile[] = [{ filePath: "src/list.ts", source: mirroredSource }];
    const clean: ProjectFile[] = [{ filePath: "src/list.ts", source: plainSource }];

    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint(mirroredSource, smelly),
      lint(plainSource, clean),
    ]);

    expect(smellyJudgments).toHaveLength(1);
    expect(smellyJudgments[0]?.probability).toBeGreaterThanOrEqual(0);
    expect(smellyJudgments[0]?.probability).toBeLessThanOrEqual(1);
    expect(cleanJudgments).toHaveLength(0);
  });
});
