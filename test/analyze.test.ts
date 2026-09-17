import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "../src/analyze.js";
import type { EvaluationRequest, Evaluator, JevLintConfig } from "../src/types.js";

class RecordingEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    return Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [
        id,
        JSON.stringify(question.instructions).includes("forward") ? 0.91 : 0.2,
      ]),
    );
  }
}

const config: JevLintConfig = {
  rules: {
    "jev/no-pass-through-wrapper": {
      scope: "function",
      question: {
        instructions: "Does this function merely forward an operation?",
        criteria: {
          true: "Only forwards arguments",
          false: "Adds meaningful behavior",
        },
      },
      threshold: 0.85,
      severity: "warning",
      message: "Pass-through wrapper adds no meaningful behavior.",
    },
    "jev/no-narrating-comment": {
      scope: "comment",
      question: {
        instructions: "Does this comment narrate obvious code?",
      },
      threshold: 0.85,
      severity: "warning",
      message: "Comment restates nearby code.",
    },
  },
};

describe("analyzeFile", () => {
  it("batches matching rules and reports judgments above their thresholds", async () => {
    const source = await readFile(new URL("./fixtures/sloppy.ts", import.meta.url), "utf8");
    const evaluator = new RecordingEvaluator();

    const diagnostics = await analyzeFile(
      {
        filePath: "src/sloppy.ts",
        source,
        changedLines: [
          { start: 3, end: 3 },
          { start: 5, end: 5 },
        ],
        config,
      },
      evaluator,
    );

    expect(evaluator.requests).toHaveLength(1);
    expect(Object.keys(evaluator.requests[0]?.questions ?? {})).toHaveLength(2);
    expect(evaluator.requests[0]?.state).toMatchObject({
      file: { path: "src/sloppy.ts" },
      candidates: [
        { kind: "comment", startLine: 3 },
        { kind: "function", startLine: 4 },
      ],
    });
    expect(diagnostics).toEqual([
      expect.objectContaining({
        filePath: "src/sloppy.ts",
        line: 4,
        ruleId: "jev/no-pass-through-wrapper",
        probability: 0.91,
      }),
    ]);
  });

  it("normalizes candidate line endings before evaluation", async () => {
    const source = "export function wrap(value: string) {\r\n  return target(value);\r\n}\r\n";
    const evaluator = new RecordingEvaluator();

    await analyzeFile(
      {
        filePath: "src/wrapper.ts",
        source,
        changedLines: [{ start: 1, end: 3 }],
        config: { rules: { "jev/no-pass-through-wrapper": config.rules["jev/no-pass-through-wrapper"]! } },
      },
      evaluator,
    );

    expect(evaluator.requests[0]?.state.candidates[0]?.source).not.toContain("\r");
    expect(evaluator.requests[0]?.state.candidates[0]?.nearbySource).not.toContain("\r");
  });

  it("does not call Jev when no changed candidate matches a rule", async () => {
    const source = "const answer = 42;\n";
    const evaluator = new RecordingEvaluator();

    const diagnostics = await analyzeFile(
      {
        filePath: "src/value.ts",
        source,
        changedLines: [{ start: 1, end: 1 }],
        config,
      },
      evaluator,
    );

    expect(diagnostics).toEqual([]);
    expect(evaluator.requests).toEqual([]);
  });
});
