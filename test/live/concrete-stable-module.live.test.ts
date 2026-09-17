import { describe, expect, it } from "vitest";
import { analyzeModules } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, ProjectFile, SourceFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class RecordingEvaluator implements Evaluator {
  probability: number | undefined;
  readonly delegate = new TypeSafeEvaluator();

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

const STORE = `export class Store {
  get(key: string): string | undefined {
    return key;
  }
}
export function openStore(path: string): Store {
  return new Store();
}
`;

const STORE_BEFORE = `export class Store {
  get(key: string): string | undefined {
    return key;
  }
}
`;

const READER_A = `import { Store } from "./store.js";
export function read(store: Store): string {
  return store.get("a") ?? "";
}
`;

const READER_B = `import { openStore } from "./store.js";
export function boot(): void {
  openStore("/data");
}
`;

liveDescribe("concrete stable module live judgment", () => {
  it("scores an all-concrete module with a real importer base", async () => {
    const files = [
      projectFile("features/storage/store.ts", STORE),
      projectFile("features/storage/reader-a.ts", READER_A),
      projectFile("features/storage/reader-b.ts", READER_B),
      projectFile(
        "features/storage/reader-c.ts",
        "import { Store } from \"./store.js\";\nexport function peek(store: Store): string {\n  return store.get(\"c\") ?? \"\";\n}\n",
      ),
      projectFile(
        "features/storage/reader-d.ts",
        "import { Store } from \"./store.js\";\nexport function has(store: Store): boolean {\n  return store.get(\"d\") !== undefined;\n}\n",
      ),
      projectFile(
        "features/storage/reader-e.ts",
        "import { openStore } from \"./store.js\";\nexport function warm(): void {\n  openStore(\"/cache\");\n}\n",
      ),
      projectFile(
        "features/storage/reader-f.ts",
        "import { Store, openStore } from \"./store.js\";\nexport function reset(): Store {\n  return openStore(\"/tmp\");\n}\n",
      ),
      ...Array.from({ length: 8 }, (_, index) => projectFile(`features/extra/widget-${index}.ts`)),
    ];
    const changes: SourceFile[] = [{
      filePath: "features/storage/store.ts",
      source: STORE,
      oldSource: STORE_BEFORE,
      changedLines: [{ start: 6, end: 8 }],
    }];

    const { judgments, probability } = await judge("jev/no-concrete-stable-module", files, changes);

    expect(judgments[0]?.ruleId).toBe("jev/no-concrete-stable-module");
    expect(probability).toBeGreaterThanOrEqual(0.85);
    expect(judgments.some(({ probability }) => probability >= 0.85)).toBe(true);
  });
});
