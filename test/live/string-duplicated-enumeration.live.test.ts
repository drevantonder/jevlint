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
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });
  evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return this.delegate.evaluate(request);
  }
}
const evaluator = new PassthroughEvaluator();

const owner: ProjectFile = {
  filePath: "src/billing.ts",
  source: `export type BillingStatus = "active" | "paused" | "archived";
export function isBillable(status: BillingStatus) {
  return status !== "archived";
}
`,
};

const afterRestated = `export function reportLabel(status: string): string {
  if (status === "active" || status === "paused") {
    return \`account \${status}\`;
  }
  if (status === "archived") {
    return "account archived";
  }
  return "account unknown";
}
`;

const afterImporting = `import type { BillingStatus } from "./billing.js";
const KNOWN: BillingStatus[] = ["active", "paused", "archived"];
export function parseBillingStatus(wire: string): BillingStatus | undefined {
  return KNOWN.find((status) => status === wire);
}
`;

function scenario(after: string) {
  const changes: SourceFile[] = [{
    filePath: "src/reporting.ts",
    source: after,
    oldSource: null,
    changedLines: [{ start: 1, end: after.split("\n").length }],
  }];
  return { changes, project: [owner, { filePath: "src/reporting.ts", source: after }] };
}

async function lint(scenarioFiles: { changes: SourceFile[]; project: ProjectFile[] }) {
  const rule = defaultConfig.rules["jev/no-string-duplicated-enumeration"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-string-duplicated-enumeration": rule } };
  return analyzeChanges({
    changes: scenarioFiles.changes,
    config,
    projectFiles: scenarioFiles.project,
  }, evaluator);
}

liveDescribe("string duplicated enumeration with structural evidence", () => {
  it("flags the restated value set but keeps the importing reuse", async () => {
    const [restatedJudgments, importingJudgments] = await Promise.all([
      lint(scenario(afterRestated)),
      lint(scenario(afterImporting)),
    ]);

    expect(restatedJudgments.length).toBeGreaterThan(0);
    expect(restatedJudgments.every(({ probability }) => probability >= 0.5)).toBe(true);
    expect(importingJudgments.every(({ probability }) => probability < 0.5)).toBe(true);
  });
});
