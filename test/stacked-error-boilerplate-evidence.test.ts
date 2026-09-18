import { describe, expect, it } from "vitest";
import { analyzeFile } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { buildStackedErrorBoilerplateEvidence } from "../src/evidence/stacked-error-boilerplate.js";
import type {
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";
import { defaultConfig } from "../src/config.js";

const STACKED = `import { writeRecord } from "./store.js";

export async function saveRecord(id: string, record: unknown): Promise<void> {
  try {
    await writeRecord(id, record);
  } catch (e) {
    throw new Error(\`failed to save record: \${e.message}\`, { cause: e });
  }
}
`;

const BARE_BOILERPLATE = `export function loadConfig(path: string): unknown {
  if (!path) {
    throw new Error("something went wrong");
  }
  return path;
}
`;

const SPECIFIC = `import { writeRecord } from "./store.js";

export async function saveRecord(id: string, record: unknown): Promise<void> {
  try {
    await writeRecord(id, record);
  } catch (e) {
    throw new Error(\`record \${id} exceeds the write limit\`, { cause: e });
  }
}
`;

const CLEAN = `export function add(left: number, right: number): number {
  return left + right;
}
`;

function candidate(source: string, filePath: string) {
  return extractCandidates(filePath, source).find(({ kind }) => kind === "function");
}

function filesFor(source: string, filePath: string): ProjectFile[] {
  return [{ filePath, source }];
}

describe("stacked error boilerplate evidence", () => {
  it("reports boilerplate that duplicates the caught error alongside a cause", () => {
    const files = filesFor(STACKED, "src/save-record.ts");
    const fn = candidate(STACKED, "src/save-record.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    const evidence = buildStackedErrorBoilerplateEvidence(fn, files);

    expect(evidence).toMatchObject({
      function: { name: "saveRecord" },
      constructions: [
        expect.objectContaining({
          matchedBoilerplate: ["failed to"],
          boilerplateOnly: false,
          hasCause: true,
          insideCatch: true,
          interpolatesCaughtMessage: true,
        }),
      ],
    });
  });

  it("reports a bare boilerplate message with no new information", () => {
    const files = filesFor(BARE_BOILERPLATE, "src/config.ts");
    const fn = candidate(BARE_BOILERPLATE, "src/config.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    const evidence = buildStackedErrorBoilerplateEvidence(fn, files);

    expect(evidence?.constructions).toEqual([
      expect.objectContaining({
        matchedBoilerplate: ["something went wrong"],
        boilerplateOnly: true,
        hasCause: false,
        insideCatch: false,
        interpolatesCaughtMessage: false,
        hasSpecificInterpolation: false,
      }),
    ]);
  });

  it("marks operation values beyond the caught error as new information", () => {
    const source = `export async function saveRecord(id: string): Promise<void> {
      try {
        await writeRecord(id);
      } catch (e) {
        throw new Error(\`failed to save record \${id}\`, { cause: e });
      }
    }`;
    const files = filesFor(source, "src/save-record.ts");
    const fn = candidate(source, "src/save-record.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildStackedErrorBoilerplateEvidence(fn, files)?.constructions).toEqual([
      expect.objectContaining({
        matchedBoilerplate: ["failed to"],
        hasCause: true,
        interpolatesCaughtMessage: false,
        hasSpecificInterpolation: true,
      }),
    ]);
  });

  it("abstains when the function constructs no error", () => {
    const files = filesFor(CLEAN, "src/add.ts");
    const fn = candidate(CLEAN, "src/add.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildStackedErrorBoilerplateEvidence(fn, files)).toBeUndefined();
  });

  it("abstains on a specific message with no boilerplate and no duplication", () => {
    const files = filesFor(SPECIFIC, "src/save-record.ts");
    const fn = candidate(SPECIFIC, "src/save-record.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildStackedErrorBoilerplateEvidence(fn, files)).toBeUndefined();
  });
});

class AssertingEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];
  constructor(private readonly scores: number[]) {}

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    return Object.fromEntries(
      Object.keys(request.questions).map((id, index) => [id, this.scores[index] ?? 0.5]),
    );
  }
}

function ruleConfig(): JevLintConfig {
  const rule = defaultConfig.rules["jev/no-stacked-error-boilerplate"];
  expect(rule).toBeDefined();
  if (!rule) throw new Error("Rule jev/no-stacked-error-boilerplate is not registered.");
  return { rules: { "jev/no-stacked-error-boilerplate": rule } };
}

function changedLines(source: string): { start: number; end: number }[] {
  return [{ start: 1, end: source.split("\n").length }];
}

describe("stacked error boilerplate through the evaluator", () => {
  it("passes evidence to the evaluator and preserves its raw score", async () => {
    const evaluator = new AssertingEvaluator([0.82]);
    const projectFiles = filesFor(STACKED, "src/save-record.ts");

    const judgments = await analyzeFile({
      filePath: "src/save-record.ts",
      source: STACKED,
      changedLines: changedLines(STACKED),
      config: ruleConfig(),
      projectFiles,
    }, evaluator);

    expect(evaluator.requests).toHaveLength(1);
    const evidence = evaluator.requests[0]?.state.candidates[0]?.evidence;
    expect(evidence).toMatchObject({
      "jev/no-stacked-error-boilerplate": {
        constructions: [{ matchedBoilerplate: ["failed to"] }],
      },
    });

    expect(judgments).toHaveLength(1);
    expect(judgments[0]?.probability).toBe(0.82);
    expect(judgments[0]?.probability).toBeGreaterThanOrEqual(0);
    expect(judgments[0]?.probability).toBeLessThanOrEqual(1);
  });

  it("asks nothing when the function constructs no error", async () => {
    const evaluator = new AssertingEvaluator([]);
    const projectFiles = filesFor(CLEAN, "src/add.ts");

    const judgments = await analyzeFile({
      filePath: "src/add.ts",
      source: CLEAN,
      changedLines: changedLines(CLEAN),
      config: ruleConfig(),
      projectFiles,
    }, evaluator);

    expect(evaluator.requests).toHaveLength(0);
    expect(judgments).toHaveLength(0);
  });
});
