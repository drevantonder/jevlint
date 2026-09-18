import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeModulesWithFailures } from "../src/analyze.js";
import { defaultConfig } from "../src/config.js";
import { buildImportTimeSideEffectEvidence } from "../src/evidence/import-time-side-effect.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
  SourceFile,
} from "../src/types.js";

const RULE = "jev/no-import-time-side-effect";
const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function moduleCandidate(filePath: string): Candidate {
  return {
    id: "module_0",
    kind: "module",
    filePath,
    source: "",
    start: 0,
    end: 0,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  };
}

function inline(filePath: string, source: string): ProjectFile[] {
  return [{ filePath, source }];
}

class FixedEvaluator implements Evaluator {
  constructor(private readonly score: number) {}
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, this.score]));
  }
}

function addedChanges(filePath: string, source: string): SourceFile[] {
  return [{
    filePath,
    source,
    oldSource: null,
    changedLines: [{ start: 1, end: source.split("\n").length }],
  }];
}

describe("import time side effect registry", () => {
  it("ships as a module judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "module",
      message: expect.any(String),
    });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("dispatches through the generated evidence registry", async () => {
    const files = await project("import-time-side-effect-positive", ["src/server.ts"]);
    const result = buildRuleEvidence(RULE, moduleCandidate("src/server.ts"), files);
    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
  });
});

describe("import time side effect evidence", () => {
  it("fires on timer, async, and server-bind effects with the importer", async () => {
    const files = await project("import-time-side-effect-positive", [
      "src/server.ts",
      "src/metrics.ts",
      "src/consumer.ts",
    ]);

    const evidence = buildImportTimeSideEffectEvidence(moduleCandidate("src/server.ts"), files);

    expect(evidence?.sideEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "timer", callee: "setInterval" }),
      expect.objectContaining({ kind: "async", callee: "connectDatabase" }),
      expect.objectContaining({ kind: "unclassified-call", callee: "server.listen" }),
      expect.objectContaining({ kind: "unclassified-call", callee: "createServer" }),
    ]));
    expect(evidence?.repository.importers).toEqual([
      expect.objectContaining({ filePath: "src/consumer.ts" }),
    ]);
    expect(evidence?.module.filePath).toBe("src/server.ts");
  });

  it("abstains on frozen config with deferred init", async () => {
    const files = await project("import-time-side-effect-negative", ["src/config.ts"]);

    expect(buildImportTimeSideEffectEvidence(moduleCandidate("src/config.ts"), files))
      .toBeUndefined();
  });

  it("records shared-state mutation and process exit distinctly", () => {
    const direct = `process.env.PORT = "3000";\nprocess.exit(1);\n`;
    const evidence = buildImportTimeSideEffectEvidence(
      moduleCandidate("src/env.ts"),
      inline("src/env.ts", direct),
    );

    expect(evidence?.sideEffects).toEqual([
      expect.objectContaining({ kind: "mutation", callee: "process.env.PORT" }),
      expect.objectContaining({ kind: "process", callee: "process.exit" }),
    ]);
  });

  it("classifies network, worker, and io callees", () => {
    const source = `import { Worker } from "node:worker_threads";\n`
      + `const worker = new Worker("./worker.js");\n`
      + `fetch("https://example.com/health");\n`
      + `setTimeout(poll, 1000);\n`
      + `export function poll() {}\n`;
    const evidence = buildImportTimeSideEffectEvidence(
      moduleCandidate("src/poller.ts"),
      inline("src/poller.ts", source),
    );

    expect(evidence?.sideEffects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "worker", callee: "Worker" }),
      expect.objectContaining({ kind: "network", callee: "fetch" }),
      expect.objectContaining({ kind: "timer", callee: "setTimeout" }),
    ]));
  });

  it("lists explicit init functions alongside the effects", () => {
    const source = `import { readFileSync } from "node:fs";\n`
      + `const schema = readFileSync("./schema.json", "utf8");\n`
      + `export function start() {\n  serve(schema);\n}\n`
      + `function serve(_schema: string) {}\n`;
    const evidence = buildImportTimeSideEffectEvidence(
      moduleCandidate("src/schema.ts"),
      inline("src/schema.ts", source),
    );

    expect(evidence?.sideEffects).toEqual([
      expect.objectContaining({ kind: "io", callee: "readFileSync" }),
    ]);
    expect(evidence?.module.initFunctions).toEqual(["start"]);
  });

  it("records a default-exported call", () => {
    const source = `import { createApp } from "./app.js";\nexport default createApp();\n`;
    const evidence = buildImportTimeSideEffectEvidence(
      moduleCandidate("src/main.ts"),
      inline("src/main.ts", source),
    );

    expect(evidence?.sideEffects).toEqual([
      expect.objectContaining({ kind: "unclassified-call", callee: "createApp" }),
    ]);
  });

  it("abstains for pure declarations and frozen config", () => {
    const source = `export type Options = { retries: number };\n`
      + `export const options = Object.freeze({ retries: 3 });\n`
      + `export function describe() {\n  return "pure";\n}\n`;
    expect(buildImportTimeSideEffectEvidence(
      moduleCandidate("src/options.ts"),
      inline("src/options.ts", source),
    )).toBeUndefined();
  });

  it("abstains structurally for test files and non-module candidates", async () => {
    const files = await project("import-time-side-effect-positive", ["src/server.ts"]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const setup: ProjectFile = { filePath: "src/setup.test.ts", source: owner.source };

    expect(buildImportTimeSideEffectEvidence(moduleCandidate("src/setup.test.ts"), [setup, ...files]))
      .toBeUndefined();
    expect(buildImportTimeSideEffectEvidence(
      { ...moduleCandidate("src/server.ts"), kind: "function" },
      files,
    )).toBeUndefined();
  });
});

describe("import time side effect wiring", () => {
  it("emits the fake evaluator raw score with evidence and no cutoff", async () => {
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const files = await project("import-time-side-effect-positive", [
      "src/server.ts",
      "src/metrics.ts",
      "src/consumer.ts",
    ]);
    const changed = files.find((file) => file.filePath === "src/server.ts");
    expect(changed).toBeDefined();
    if (!changed) return;

    const high = await analyzeModulesWithFailures({
      changes: addedChanges(changed.filePath, changed.source),
      config,
      projectFiles: files,
    }, new FixedEvaluator(0.82));
    expect(high.failures).toEqual([]);
    expect(high.judgments).toHaveLength(1);
    expect(high.judgments[0]).toMatchObject({
      ruleId: RULE,
      probability: 0.82,
      filePath: "src/server.ts",
    });
    expect(JSON.stringify(high.judgments[0]?.evidence)).toContain("setInterval");

    const low = await analyzeModulesWithFailures({
      changes: addedChanges(changed.filePath, changed.source),
      config,
      projectFiles: files,
    }, new FixedEvaluator(0.04));
    expect(low.judgments).toHaveLength(1);
    expect(low.judgments[0]?.probability).toBe(0.04);
  });

  it("abstains the unchanged-shape module without evaluation", async () => {
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const files = await project("import-time-side-effect-negative", ["src/config.ts"]);
    const changed = files[0];
    expect(changed).toBeDefined();
    if (!changed) return;

    const result = await analyzeModulesWithFailures({
      changes: addedChanges(changed.filePath, changed.source),
      config,
      projectFiles: files,
    }, new FixedEvaluator(0.9));

    expect(result.judgments).toEqual([]);
    expect(result.abstentions).toEqual([{ ruleId: RULE, candidateKind: "module", count: 1 }]);
  });
});
