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
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });
  evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return this.delegate.evaluate(request);
  }
}

const before = `export type Status = "active" | "paused";
`;

const after = `export type Status = "active" | "paused" | "archived";
`;

const openMirror = `import type { Status } from "./types";
export function renderBadge(status: Status): string {
  switch (status) {
    case "active": return "on";
    case "paused": return "hold";
    default: return "off";
  }
}
`;

const exhaustiveMirror = `import type { Status } from "./types";
function assertNever(value: never): never {
  throw new Error(\`unhandled: \${String(value)}\`);
}
export function renderBadge(status: Status): string {
  switch (status) {
    case "active": return "on";
    case "paused": return "hold";
    default: return assertNever(status);
  }
}
`;

type ChangeScenario = {
  changes: SourceFile[];
  project: ProjectFile[];
};

function scenario(mirror: string): ChangeScenario {
  const changes: SourceFile[] = [{
    filePath: "src/types.ts",
    source: after,
    oldSource: before,
    changedLines: [{ start: 1, end: 1 }],
  }];
  const project: ProjectFile[] = [
    { filePath: "src/types.ts", source: after },
    { filePath: "src/renderer.ts", source: mirror },
  ];
  return { changes, project };
}

async function lint(changes: SourceFile[], project: ProjectFile[], evaluator: Evaluator) {
  const rule = defaultConfig.rules["jev/no-change-amplifier-case"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-change-amplifier-case": rule } };
  return analyzeChanges({ changes, config, projectFiles: project }, evaluator);
}

liveDescribe("change amplifier case calibration", () => {
  it("flags an unmirrored new member but keeps an exhaustive mirror low", async () => {
    const open = scenario(openMirror);
    const exhaustive = scenario(exhaustiveMirror);
    const [openJudgments, exhaustiveJudgments] = await Promise.all([
      lint(open.changes, open.project, new PassthroughEvaluator()),
      lint(exhaustive.changes, exhaustive.project, new PassthroughEvaluator()),
    ]);

    expect(openJudgments.map(({ ruleId }) => ruleId)).toContain(
      "jev/no-change-amplifier-case",
    );
    expect(exhaustiveJudgments.every(({ probability }) => probability < 0.6)).toBe(true);
  });
});
