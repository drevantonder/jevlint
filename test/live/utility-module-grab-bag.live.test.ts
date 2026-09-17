import { describe, expect, it } from "vitest";
import { analyzeChanges } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type {
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
  SourceFile,
} from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class PassthroughEvaluator implements Evaluator {
  readonly delegate = new TypeSafeEvaluator();
  evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return this.delegate.evaluate(request);
  }
}

const beforeUtils = `export function formatDate(value: Date) {
  return value.toISOString();
}
export function retryHttp(url: string) {
  return fetch(url);
}
`;

const afterGrabBag = `${beforeUtils}export function parseCsv(text: string) {
  return text.split(",");
}
`;

const afterCohesive = `${beforeUtils}export function formatTime(value: Date) {
  return value.toTimeString();
}
`;

const project: ProjectFile[] = [
  {
    filePath: "src/render.ts",
    source: `import { formatDate } from "./utils.js";\nexport function render(value: Date) {\n  return formatDate(value);\n}\n`,
  },
  {
    filePath: "src/sync.ts",
    source: `import { retryHttp } from "./utils.js";\nexport function sync(url: string) {\n  return retryHttp(url);\n}\n`,
  },
];

type Scenario = { changes: SourceFile[]; files: ProjectFile[] };

function scenario(after: string): Scenario {
  const changes: SourceFile[] = [{
    filePath: "src/utils.ts",
    source: after,
    oldSource: beforeUtils,
    changedLines: [{ start: 7, end: 9 }],
  }];
  return { changes, files: [{ filePath: "src/utils.ts", source: after }, ...project] };
}

async function lint(changes: SourceFile[], files: ProjectFile[], evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-utility-module-grab-bag"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-utility-module-grab-bag": rule } };
  return analyzeChanges({ changes, config, projectFiles: files }, evaluator);
}

liveDescribe("utility module grab bag calibration", () => {
  it("flags an unrelated newcomer but keeps a cohesive string helper", async () => {
    const grabBag = scenario(afterGrabBag);
    const cohesive = scenario(afterCohesive);
    const [grabBagJudgments, cohesiveJudgments] = await Promise.all([
      lint(grabBag.changes, grabBag.files, new PassthroughEvaluator()),
      lint(cohesive.changes, cohesive.files, new PassthroughEvaluator()),
    ]);

    expect(grabBagJudgments.map(({ ruleId }) => ruleId)).toContain("jev/no-utility-module-grab-bag");
    expect(cohesiveJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
