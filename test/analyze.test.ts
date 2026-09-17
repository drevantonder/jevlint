import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  analyzeChangesWithFailures,
  analyzeFile,
  analyzeFileWithFailures,
  EVALUATION_REQUEST_BUDGET_CHARS,
} from "../src/analyze.js";
import { CachedEvaluator } from "../src/cache.js";
import type { EvaluationRequest, Evaluator, JevLintConfig, SourceFile } from "../src/types.js";

class RecordingEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    return Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => [
        id,
        /forward|whole change/.test(JSON.stringify(question.instructions)) ? 0.91 : 0.2,
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
      message: "Pass-through wrapper adds no meaningful behavior.",
    },
    "jev/no-narrating-comment": {
      scope: "comment",
      question: {
        instructions: "Does this comment narrate obvious code?",
      },
      message: "Comment restates nearby code.",
    },
  },
};

const functionConfig: JevLintConfig = {
  rules: {
    "test/function": {
      scope: "function",
      question: { instructions: "Is this a function?" },
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

function forgeSizedChanges(): SourceFile[] {
  return Array.from({ length: 16 }, (_, fileIndex) => {
    const declarations = Array.from({ length: 12 }, (_, declarationIndex) => {
      const payload = "x".repeat(700);
      return `export function operation${fileIndex}_${declarationIndex}(value: string) { return value + "${payload}"; }`;
    });
    const oldSource = declarations.join("\n");
    const source = oldSource.replaceAll("return value +", "return normalize(value) +");
    return {
      filePath: `packages/area-${String(fileIndex).padStart(2, "0")}/src/operations.ts`,
      oldSource,
      source,
      changedLines: [{ start: 1, end: declarations.length }],
    };
  });
}

describe("analyzeFile", () => {
  it("reports every completed judgment, including low scores", async () => {
    const source = await readFile(new URL("./fixtures/sloppy.ts", import.meta.url), "utf8");
    const evaluator = new RecordingEvaluator();

    const judgments = await analyzeFile(
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
    expect(judgments).toEqual([
      expect.objectContaining({
        filePath: "src/sloppy.ts",
        span: { start: { line: 4, column: 8 }, end: expect.any(Object) },
        candidateKind: "function",
        ruleId: "jev/no-pass-through-wrapper",
        probability: 0.91,
        evidence: expect.any(Object),
      }),
      expect.objectContaining({
        candidateKind: "comment",
        ruleId: "jev/no-narrating-comment",
        probability: 0.2,
        evidence: null,
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
    expect(result.judgments).toHaveLength(36);
    expect(result.failures).toEqual([]);
  });

  it("bounds and caches a Forge-sized whole-change judgment without splitting it", async () => {
    const changes = forgeSizedChanges();
    const live = new RecordingEvaluator();
    const cacheDirectory = await mkdtemp(join(tmpdir(), "jevlint-whole-change-cache-"));
    const evaluator = new CachedEvaluator(live, {
      directory: cacheDirectory,
      repository: "/forge",
      identity: {
        provider: "test-provider",
        endpoint: "https://example.test",
        model: "jev-test-1",
        sdk: "test-sdk@1",
        evaluator: "test-evaluator-v1",
      },
    });
    const changeConfig: JevLintConfig = {
      rules: {
        "jev/no-complexity-displacement": {
          scope: "change",
          question: { instructions: "Does the whole change displace complexity?" },
          message: "Complexity moved.",
        },
      },
    };
    const input = {
      changes,
      config: changeConfig,
      projectFiles: changes.map(({ filePath, source }) => ({ filePath, source })),
    };

    const first = await analyzeChangesWithFailures(input, evaluator);
    const second = await analyzeChangesWithFailures(input, evaluator);

    expect(live.requests).toHaveLength(1);
    const serializedSize = JSON.stringify(live.requests[0]).length;
    expect(serializedSize).toBeLessThan(EVALUATION_REQUEST_BUDGET_CHARS);
    expect(Object.keys(live.requests[0]?.questions ?? {})).toEqual(["q0"]);
    expect(live.requests[0]?.state.candidates[0]?.evidence?.["jev/no-complexity-displacement"])
      .toMatchObject({
        coverage: {
          totalFiles: 16,
          includedFiles: 8,
          omittedFiles: 8,
          includedFilePaths: Array.from(
            { length: 8 },
            (_, index) => `packages/area-${String(index).padStart(2, "0")}/src/operations.ts`,
          ),
          omittedFilePaths: Array.from(
            { length: 8 },
            (_, index) => `packages/area-${String(index + 8).padStart(2, "0")}/src/operations.ts`,
          ),
          unlistedOmittedFiles: 0,
          truncatedFiles: Array.from(
            { length: 8 },
            (_, index) => `packages/area-${String(index).padStart(2, "0")}/src/operations.ts`,
          ),
        },
      });
    expect(first).toMatchObject({
      judgments: [expect.objectContaining({ ruleId: "jev/no-complexity-displacement" })],
      failures: [],
    });
    expect(second).toMatchObject({
      judgments: [expect.objectContaining({ ruleId: "jev/no-complexity-displacement" })],
      failures: [],
    });
    expect(evaluator.statistics).toMatchObject({
      hits: 1,
      misses: 1,
      writes: 1,
      liveRequests: 1,
    });
  });

  it("retains schema and rule identity through batching and recursive splitting", async () => {
    const assertQuestionIdentity = (request: EvaluationRequest): void => {
      for (const question of Object.values(request.questions)) {
        expect(question.instructions).toMatchObject({
          schema: "jevlint-semantic-judgment-v1",
          ruleId: "test/function",
        });
      }
    };

    const normalRequests: EvaluationRequest[] = [];
    const normalEvaluator: Evaluator = {
      async evaluate(request) {
        assertQuestionIdentity(request);
        normalRequests.push(request);
        return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.9]));
      },
    };
    const payload = "x".repeat(2_000);
    const largeSource = functions(36, `return "${payload}";`);
    const normal = await analyzeFileWithFailures({
      filePath: "src/schema-large.ts",
      source: largeSource,
      changedLines: [{ start: 1, end: 36 }],
      config: functionConfig,
    }, normalEvaluator);

    const splitRequestSizes: number[] = [];
    const splittingEvaluator: Evaluator = {
      async evaluate(request) {
        assertQuestionIdentity(request);
        const size = Object.keys(request.questions).length;
        splitRequestSizes.push(size);
        if (size > 2) throw new Error("400 max_tokens_exceeded");
        return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.9]));
      },
    };
    const split = await analyzeFileWithFailures({
      filePath: "src/schema-split.ts",
      source: functions(8),
      changedLines: [{ start: 1, end: 8 }],
      config: functionConfig,
    }, splittingEvaluator);

    expect(normalRequests).toHaveLength(2);
    expect(normal.judgments).toHaveLength(36);
    expect(normal.failures).toEqual([]);
    expect(splitRequestSizes).toEqual([8, 4, 2, 2, 4, 2, 2]);
    expect(split.judgments).toHaveLength(8);
    expect(split.failures).toEqual([]);
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
    expect(result.judgments).toHaveLength(8);
    expect(result.failures).toEqual([]);
  });

  it("preserves completed judgments when one question remains too large", async () => {
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
    expect(result.judgments).toHaveLength(3);
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
    expect(result.judgments).toEqual([]);
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

  it("summarizes structural ineligibility without assigning a score", async () => {
    const source = "export function calculate() { return 1; }\n";
    const evaluator = new RecordingEvaluator();

    const result = await analyzeFileWithFailures({
      filePath: "src/calculate.ts",
      source,
      changedLines: [{ start: 1, end: 1 }],
      config: { rules: { "jev/no-pass-through-wrapper": config.rules["jev/no-pass-through-wrapper"]! } },
    }, evaluator);

    expect(result.judgments).toEqual([]);
    expect(result.abstentions).toEqual([{
      ruleId: "jev/no-pass-through-wrapper",
      candidateKind: "function",
      count: 1,
    }]);
    expect(evaluator.requests).toEqual([]);
  });

  it("does not call Jev when no changed candidate matches a rule", async () => {
    const source = "const answer = 42;\n";
    const evaluator = new RecordingEvaluator();

    const judgments = await analyzeFile(
      {
        filePath: "src/value.ts",
        source,
        changedLines: [{ start: 1, end: 1 }],
        config,
      },
      evaluator,
    );

    expect(judgments).toEqual([]);
    expect(evaluator.requests).toEqual([]);
  });
});
