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

const SMELLY: ProjectFile = {
  filePath: "src/http.ts",
  source: "import https from \"node:https\";\n"
    + "export function getJson(url: string): Promise<unknown> {\n"
    + "  return new Promise((resolve, reject) => {\n"
    + "    https.get(url, (response) => {\n"
    + "      const chunks: Buffer[] = [];\n"
    + "      response.on(\"data\", (chunk: Buffer) => chunks.push(chunk));\n"
    + "      response.on(\"end\", () => {\n"
    + "        if (response.statusCode !== 200) reject(new Error(\"bad status\"));\n"
    + "        else resolve(JSON.parse(Buffer.concat(chunks).toString()));\n"
    + "      });\n"
    + "    }).on(\"error\", reject);\n"
    + "  });\n"
    + "}\n",
};
const PAIRED: ProjectFile = {
  filePath: "src/http.ts",
  source: "export function getJson(url: string): Promise<unknown> {\n"
    + "  return fetch(url).then((response) => {\n"
    + "    if (!response.ok) throw new Error(\"bad status\");\n"
    + "    return response.json();\n"
    + "  });\n"
    + "}\n",
};

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/http.ts");
  const rule = defaultConfig.rules["jev/no-hand-rolled-fetch-wrapper"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-hand-rolled-fetch-wrapper": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("hand rolled fetch wrapper with structural evidence", () => {
  it("flags https assembly but keeps the fetch helper", async () => {
    const smellyEvaluator = new RecordingEvaluator();
    const cleanEvaluator = new RecordingEvaluator();
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lint([SMELLY], smellyEvaluator),
      lint([PAIRED], cleanEvaluator),
    ]);

    expect(smellyEvaluator.probabilities.get("src/http.ts")).toBeGreaterThanOrEqual(0.85);
    expect(smellyJudgments.some(({ probability }) => probability >= 0.85)).toBe(true);
    expect(cleanJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
