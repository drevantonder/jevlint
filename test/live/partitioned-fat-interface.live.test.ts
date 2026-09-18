import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  readonly probabilities = new Map<string, number>();
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.JEVLINT_TYPESAFE_API_KEY ?? "" });
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    const probability = answers.q0;
    if (probability !== undefined) this.probabilities.set(request.state.file.path, probability);
    return answers;
  }
}

const REGISTRY = `export class ServiceRegistry {
  addAdmin(name: string): void {
  }
  removeAdmin(name: string): void {
  }
  addCustomer(name: string): void {
  }
  removeCustomer(name: string): void {
  }
}
`;

const ADMIN_CLIENT = `import { ServiceRegistry } from "./registry.js";
const registry = new ServiceRegistry();
export function onboard(name: string): void {
  registry.addAdmin(name);
  registry.removeAdmin("legacy");
}
`;

const SHOP_CLIENT = `import { ServiceRegistry } from "./registry.js";
const registry = new ServiceRegistry();
export function checkout(name: string): void {
  registry.addCustomer(name);
  registry.removeCustomer("guest");
}
`;

async function lint(projectFiles: ProjectFile[], evaluator: Evaluator) {
  const changed = projectFiles[0];
  const rule = defaultConfig.rules["jev/no-partitioned-fat-interface"];
  expect(changed).toBeDefined();
  expect(rule).toBeDefined();
  if (!changed || !rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-partitioned-fat-interface": rule } };
  return analyzeFile({
    filePath: changed.filePath,
    source: changed.source,
    changedLines: [{ start: 1, end: changed.source.split("\n").length }],
    config,
    projectFiles,
  }, evaluator);
}

liveDescribe("partitioned fat interface live judgment", () => {
  it("scores a class serving disjoint admin and customer callers", async () => {
    const files: ProjectFile[] = [
      { filePath: "src/registry.ts", source: REGISTRY },
      { filePath: "src/admin.ts", source: ADMIN_CLIENT },
      { filePath: "src/shop.ts", source: SHOP_CLIENT },
    ];
    const evaluator = new RecordingEvaluator();

    const judgments = await lint(files, evaluator);

    expect(judgments.map(({ ruleId }) => ruleId)).toContain("jev/no-partitioned-fat-interface");
    for (const judgment of judgments) {
      expect(judgment.probability).toBeGreaterThanOrEqual(0);
      expect(judgment.probability).toBeLessThanOrEqual(1);
    }
  });
});
