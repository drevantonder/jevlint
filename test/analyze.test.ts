import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  analyzeFile,
  analyzeFileWithFailures,
  EVALUATION_REQUEST_BUDGET_CHARS,
} from "../src/analyze.js";
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

const functionConfig: JevLintConfig = {
  rules: {
    "test/function": {
      scope: "function",
      question: { instructions: "Is this a function?" },
      threshold: 0.8,
      severity: "warning",
      message: "Function found.",
    },
  },
};

function functions(count: number, body = "return 1;"): string {
  return Array.from(
    { length: count },
    (_, index) => `export function function${index}() { ${body} }`,
  ).join("\n");
}

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

  it("splits an oversized file into token-budgeted requests", async () => {
    const payload = "x".repeat(2_000);
    const source = functions(36, `return "${payload}";`);
    const evaluator = new RecordingEvaluator();

    const result = await analyzeFileWithFailures({
      filePath: "src/large.ts",
      source,
      changedLines: [{ start: 1, end: 36 }],
      config: functionConfig,
    }, evaluator);

    expect(evaluator.requests).toHaveLength(2);
    expect(evaluator.requests.every((request) =>
      JSON.stringify(request).length <= EVALUATION_REQUEST_BUDGET_CHARS
    )).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
    expect(result.failures).toEqual([]);
  });

  it("sends module context once instead of repeating it in rule evidence", async () => {
    const source = `const moduleMarker = "module-context-marker";
      export async function load() {
        await loadFirst();
        await loadSecond();
      }`;
    const evaluator = new RecordingEvaluator();
    const orchestrationConfig: JevLintConfig = {
      rules: {
        "jev/no-avoidable-orchestration": {
          scope: "function",
          question: { instructions: "Is this avoidable orchestration?" },
          threshold: 0.8,
          severity: "warning",
          message: "Avoidable orchestration.",
        },
      },
    };

    await analyzeFileWithFailures({
      filePath: "src/load.ts",
      source,
      changedLines: [{ start: 2, end: 5 }],
      config: orchestrationConfig,
    }, evaluator);

    const request = evaluator.requests[0];
    expect(request?.state.file.source).toContain("module-context-marker");
    expect(request?.state.candidates[0]?.evidence?.["jev/no-avoidable-orchestration"])
      .not.toHaveProperty("function.source");
    expect(JSON.stringify(request).match(/module-context-marker/g)).toHaveLength(1);
  });

  it("recursively splits token-limit failures until every question completes", async () => {
    const source = functions(8);
    const requestSizes: number[] = [];
    const evaluator: Evaluator = {
      async evaluate(request) {
        const size = Object.keys(request.questions).length;
        requestSizes.push(size);
        if (size > 2) throw new Error("400 max_tokens_exceeded");
        return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.9]));
      },
    };

    const result = await analyzeFileWithFailures({
      filePath: "src/eight.ts",
      source,
      changedLines: [{ start: 1, end: 8 }],
      config: functionConfig,
    }, evaluator);

    expect(requestSizes).toEqual([8, 4, 2, 2, 4, 2, 2]);
    expect(result.diagnostics).toHaveLength(8);
    expect(result.failures).toEqual([]);
  });

  it("preserves completed diagnostics when one question remains too large", async () => {
    const source = [
      "export function first() { return 1; }",
      "export function second() { return 2; }",
      "export function third() { return 3; }",
      "export function broken() { return 4; }",
    ].join("\n");
    const requestSizes: number[] = [];
    const evaluator: Evaluator = {
      async evaluate(request) {
        requestSizes.push(Object.keys(request.questions).length);
        if (request.state.candidates.some((candidate) => candidate.source.includes("broken"))) {
          throw new Error("400 max_tokens_exceeded");
        }
        return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.9]));
      },
    };

    const result = await analyzeFileWithFailures({
      filePath: "src/partial.ts",
      source,
      changedLines: [{ start: 1, end: 4 }],
      config: functionConfig,
    }, evaluator);

    expect(requestSizes).toEqual([4, 2, 2, 1, 1]);
    expect(result.diagnostics).toHaveLength(3);
    expect(result.failures).toEqual([expect.objectContaining({
      filePath: "src/partial.ts",
      questionCount: 1,
      ruleIds: ["test/function"],
      message: "400 max_tokens_exceeded",
    })]);
  });

  it("reports a non-token evaluator error once for the bounded batch", async () => {
    const source = functions(10);
    let requests = 0;
    const evaluator: Evaluator = {
      async evaluate() {
        requests += 1;
        throw new Error("service unavailable");
      },
    };

    const result = await analyzeFileWithFailures({
      filePath: "src/unavailable.ts",
      source,
      changedLines: [{ start: 1, end: 10 }],
      config: functionConfig,
    }, evaluator);

    expect(requests).toBe(1);
    expect(result.diagnostics).toEqual([]);
    expect(result.failures).toEqual([expect.objectContaining({
      filePath: "src/unavailable.ts",
      questionCount: 10,
      message: "service unavailable",
    })]);
  });

  it("normalizes candidate line endings before evaluation", async () => {
    const source = "// Return the value.\r\nexport function identity(value: string) {\r\n  return value;\r\n}\r\n";
    const evaluator = new RecordingEvaluator();

    await analyzeFile(
      {
        filePath: "src/identity.ts",
        source,
        changedLines: [{ start: 1, end: 1 }],
        config: { rules: { "jev/no-narrating-comment": config.rules["jev/no-narrating-comment"]! } },
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
