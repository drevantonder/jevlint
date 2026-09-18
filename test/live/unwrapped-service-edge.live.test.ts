import { describe, expect, it } from "vitest";
import { analyzeModules } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile, SourceFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  probability: number | undefined;
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    const answers = await this.delegate.evaluate(request);
    this.probability = answers.q0;
    return answers;
  }
}

function projectFile(filePath: string, source = "export const value = 1;\n"): ProjectFile {
  return { filePath, source };
}

async function judge(ruleId: string, files: ProjectFile[], changes: SourceFile[]) {
  const rule = defaultConfig.rules[ruleId];
  expect(rule).toBeDefined();
  if (!rule) return { judgments: [], probability: undefined };
  const config: JevLintConfig = { rules: { [ruleId]: rule } };
  const evaluator = new RecordingEvaluator();
  const judgments = await analyzeModules({ changes, config, projectFiles: files }, evaluator);
  return { judgments, probability: evaluator.probability };
}

const trackBefore = `export async function track(id: string) {
  return id;
}
`;

const trackAfter = `import { statusOf } from "./status.js";
export async function track(id: string) {
  const response = await fetch(\`https://api.carrier.example.com/v1/track/\${id}\`);
  return statusOf(await response.json());
}
`;

liveDescribe("unwrapped service edge live judgment", () => {
  it("scores a novel host fetched outside the established wrapper", async () => {
    const client = "import axios from 'axios';\nexport async function getJson(url: string) {\n  const response = await axios.get(url);\n  return response.data;\n}\n";
    const user = (name: string) =>
      `import { getJson } from "../http/client.js";\nexport async function ${name}() {\n  return getJson("https://api.shop.example.com/${name}");\n}\n`;
    const files = [
      projectFile("http/client.ts", client),
      projectFile("billing/checkout.ts", user("checkout")),
      projectFile("orders/cart.ts", user("cart")),
      projectFile("shipping/rates.ts", user("rates")),
      projectFile("shipping/status.ts", "export function statusOf(payload: unknown) {\n  return payload;\n}\n"),
      projectFile("shipping/track.ts", trackAfter),
      ...Array.from({ length: 5 }, (_, index) => projectFile(`extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "shipping/track.ts",
      source: trackAfter,
      oldSource: trackBefore,
      changedLines: [{ start: 3, end: 3 }],
    }];

    const { judgments, probability } = await judge("jev/no-unwrapped-service-edge", files, changes);

    expect(judgments).toHaveLength(1);
    expect(judgments[0]?.ruleId).toBe("jev/no-unwrapped-service-edge");
    expect(probability).toBeGreaterThanOrEqual(0);
    expect(probability).toBeLessThanOrEqual(1);
  });
});
