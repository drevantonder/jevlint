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

const before = `export function notify() {
  return send("none");
}
`;

const afterBypass = `export function notify() {
  const key = process.env.NOTIFY_KEY;
  return send(key);
}
`;

const afterDelegating = `import { config } from "./config";
import dotenv from "dotenv";
dotenv.config();
export function notify() {
  return send(config.stripeKey);
}
`;

const ownedConfig: ProjectFile = {
  filePath: "src/config/index.ts",
  source: `export const config = { stripeKey: process.env.STRIPE_KEY ?? "" };
`,
};

const siblingA: ProjectFile = {
  filePath: "src/billing.ts",
  source: `import { config } from "./config";
export function charge() {
  return config.stripeKey;
}
`,
};

const siblingB: ProjectFile = {
  filePath: "src/refunds.ts",
  source: `import { config } from "./config";
export function refund() {
  return config.stripeKey;
}
`,
};

type ChangeScenario = {
  changes: SourceFile[];
  project: ProjectFile[];
};

function scenario(after: string): ChangeScenario {
  const changes: SourceFile[] = [{
    filePath: "src/notify.ts",
    source: after,
    oldSource: before,
    changedLines: [{ start: 1, end: 6 }],
  }];
  const project: ProjectFile[] = [
    ownedConfig,
    siblingA,
    siblingB,
    { filePath: "src/notify.ts", source: after },
  ];
  return { changes, project };
}

async function lint(changes: SourceFile[], project: ProjectFile[], evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-duplicate-config-source"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-duplicate-config-source": rule } };
  return analyzeChanges({ changes, config, projectFiles: project }, evaluator);
}

liveDescribe("duplicate config source calibration", () => {
  it("flags a bypassing env read but keeps a delegating channel", async () => {
    const bypass = scenario(afterBypass);
    const delegating = scenario(afterDelegating);
    const [bypassJudgments, delegatingJudgments] = await Promise.all([
      lint(bypass.changes, bypass.project, new PassthroughEvaluator()),
      lint(delegating.changes, delegating.project, new PassthroughEvaluator()),
    ]);

    expect(bypassJudgments.map(({ ruleId }) => ruleId)).toContain(
      "jev/no-duplicate-config-source",
    );
    expect(delegatingJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
