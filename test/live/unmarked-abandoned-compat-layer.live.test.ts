import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class PassthroughEvaluator implements Evaluator {
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });
  evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return this.delegate.evaluate(request);
  }
}
const evaluator = new PassthroughEvaluator();

const SMELLY: ProjectFile[] = [
  {
    filePath: "src/legacyAuth.ts",
    source: "export function legacyAuthenticate(token: string): boolean {\n"
      + "  return token.length > 0;\n"
      + "}\n",
  },
  {
    filePath: "src/auth.ts",
    source: "export function authenticate(token: string): boolean {\n"
      + "  return token.trim().length >= 8;\n"
      + "}\n",
  },
  {
    filePath: "src/app.ts",
    source: "import { authenticate } from \"./auth.js\";\n"
      + "export function login(token: string): string {\n"
      + "  return authenticate(token) ? \"ok\" : \"denied\";\n"
      + "}\n",
  },
];
const PAIRED: ProjectFile[] = [
  {
    filePath: "src/currentAuth.ts",
    source: "export function authenticate(token: string): boolean {\n"
      + "  return token.trim().length >= 8;\n"
      + "}\n",
  },
  {
    filePath: "src/app.ts",
    source: "import { authenticate } from \"./currentAuth.js\";\n"
      + "export function login(token: string): string {\n"
      + "  return authenticate(token) ? \"ok\" : \"denied\";\n"
      + "}\n",
  },
];

async function lint(projectFiles: ProjectFile[]) {
  const changed = projectFiles.find(({ filePath }) => filePath === "src/legacyAuth.ts")
    ?? projectFiles.find(({ filePath }) => filePath === "src/currentAuth.ts");
  const rule = defaultConfig.rules["jev/no-unmarked-abandoned-compat-layer"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-unmarked-abandoned-compat-layer": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("unmarked abandoned compat layer with structural evidence", () => {
  it("flags the callerless legacy layer but keeps the current contract", async () => {
    const [smellyJudgments, pairedJudgments] = await Promise.all([
      lint(SMELLY),
      lint(PAIRED),
    ]);

    expect(smellyJudgments.length).toBeGreaterThan(0);
    expect(pairedJudgments.length).toBe(0);
  });
});
