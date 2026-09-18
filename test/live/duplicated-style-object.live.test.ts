import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    const probability = answers.q0;
    if (probability !== undefined) this.probabilities.set(request.state.file.path, probability);
    return answers;
  }
}

const CARD = "const card = {\n"
  + "    borderRadius: 8,\n"
  + "    boxShadow: \"0 1px 4px rgba(0,0,0,0.12)\",\n"
  + "    padding: 16,\n"
  + "    backgroundColor: \"#ffffff\",\n"
  + "    margin: 12,\n"
  + "  };\n";

const SMELLY: ProjectFile = {
  filePath: "src/CardA.tsx",
  source: "import { theme } from \"./theme.js\";\n"
    + `export function CardA(): unknown {\n  ${CARD}  return [card, theme];\n}\n`,
};
const TWIN: ProjectFile = {
  filePath: "src/CardB.tsx",
  source: `export function CardB(): unknown {\n  ${CARD}  return card;\n}\n`,
};
const THEME: ProjectFile = {
  filePath: "src/theme.ts",
  source: "export const theme = {\n"
    + "  radius: 8,\n"
    + "  spacing: 16,\n"
    + "};\n",
};
const PAIRED: ProjectFile = {
  filePath: "src/CardA.tsx",
  source: "export function CardA(): unknown {\n"
    + "  const card = {\n"
    + "    borderRadius: 4,\n"
    + "    padding: 8,\n"
    + "    margin: 2,\n"
    + "    color: \"red\",\n"
    + "  };\n"
    + "  return card;\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/CardA.tsx");
  const rule = defaultConfig.rules["jev/no-duplicated-style-object"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-duplicated-style-object": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("duplicated style object with structural evidence", () => {
  it("flags a copied card object but keeps a one-off style", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY, TWIN, THEME], smellyEvaluator),
      lint([PAIRED], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/CardA.tsx")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
