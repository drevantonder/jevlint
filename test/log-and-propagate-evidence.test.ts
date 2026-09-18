import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildLogAndPropagateEvidence } from "../src/evidence/log-and-propagate.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const RULE = "jev/no-log-and-propagate";
const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function functionCandidate(files: ProjectFile[], excerpt: string): Candidate {
  const owner = files[0];
  expect(owner).toBeDefined();
  if (!owner) throw new Error("Fixture has no changed file.");
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find(({ kind, source }) => kind === "function" && source.includes(excerpt));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error(`Fixture has no function containing ${excerpt}.`);
  return candidate;
}

class StubEvaluator implements Evaluator {
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.73]));
  }
}

describe("log and propagate wiring", () => {
  it("ships as a function judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "function",
      message: expect.any(String),
    });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("fires on a try/catch that records and rethrows the same error", async () => {
    const files = await project("log-and-propagate-smelly", [
      "src/refund.ts",
      "src/services.ts",
      "src/orders.ts",
    ]);

    const result = buildRuleEvidence(RULE, functionCandidate(files, "refundPayment("), files);

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
    if (!result.handled) return;
    expect(result.evidence).toMatchObject({
      function: { name: "refundPayment", exported: true },
      handlers: [expect.objectContaining({
        kind: "try-catch",
        caught: "error",
        tryBlock: expect.stringContaining("payments.refund"),
        catchBody: expect.stringContaining("logger.error"),
        logCalls: [expect.stringContaining("logger.error")],
        propagations: [expect.stringContaining("throw error")],
        logsCaughtError: true,
        propagatesCaughtError: true,
      })],
      callers: [expect.objectContaining({
        filePath: "src/orders.ts",
        call: expect.stringContaining("refundPayment"),
        recordsFailure: false,
      })],
    });
  });

  it("fires on a .catch() callback that records and rethrows", async () => {
    const files = await project("log-and-propagate-smelly", [
      "src/refund.ts",
      "src/services.ts",
      "src/orders.ts",
    ]);

    expect(buildLogAndPropagateEvidence(
      functionCandidate(files, "refundPaymentLater"),
      files,
    )).toMatchObject({
      handlers: [expect.objectContaining({
        kind: "catch-callback",
        caught: "error",
        logCalls: [expect.stringContaining("logger.error")],
        propagations: [expect.stringContaining("throw error")],
        logsCaughtError: true,
        propagatesCaughtError: true,
      })],
    });
  });

  it("abstains when the catch records without propagating", async () => {
    const files = await project("log-and-propagate-clean", [
      "src/loader.ts",
      "src/services.ts",
      "src/app.ts",
    ]);

    expect(buildLogAndPropagateEvidence(
      functionCandidate(files, "loadCached"),
      files,
    )).toBeUndefined();
  });

  it("abstains when the catch propagates without recording", async () => {
    const files = await project("log-and-propagate-clean", [
      "src/loader.ts",
      "src/services.ts",
      "src/app.ts",
    ]);

    expect(buildLogAndPropagateEvidence(
      functionCandidate(files, "loadRequired"),
      files,
    )).toBeUndefined();
  });

  it("shows Jev the upstream handler that records the same failure again", async () => {
    const files = await project("log-and-propagate-clean", [
      "src/loader.ts",
      "src/services.ts",
      "src/app.ts",
    ]);
    const app = files.find(({ filePath }) => filePath === "src/app.ts");
    expect(app).toBeDefined();
    if (!app) return;
    const boot = extractCandidates(app.filePath, app.source)
      .find(({ kind, source }) => kind === "function" && source.includes("boot("));
    expect(boot).toBeDefined();
    if (!boot) return;

    expect(buildLogAndPropagateEvidence(boot, files)).toMatchObject({
      function: { name: "boot" },
      handlers: [expect.objectContaining({
        logsCaughtError: true,
        propagatesCaughtError: true,
      })],
      callers: [],
    });
  });

  it("abstains for non-function candidates", async () => {
    const files = await project("log-and-propagate-smelly", ["src/refund.ts"]);
    const owner = files[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "comment");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildLogAndPropagateEvidence(candidate, files)).toBeUndefined();
  });

  it("abstains when a function has no catch handler", () => {
    const source = "export async function load() { return await fetchValue(); }";
    const candidate = extractCandidates("src/load.ts", source)[0];
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildLogAndPropagateEvidence(candidate, [{ filePath: "src/load.ts", source }]))
      .toBeUndefined();
  });

  it("sends dual handlers to evaluation with raw scores and abstains the rest", async () => {
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const evaluator = new StubEvaluator();

    const dualSource = `import { logger } from "./services.js";
export async function save(value: string) {
  try {
    await write(value);
  } catch (error) {
    logger.error("save failed", { error });
    throw error;
  }
}
`;
    const dual = await analyzeFileWithFailures({
      filePath: "src/save.ts",
      source: dualSource,
      changedLines: [{ start: 1, end: 9 }],
      config,
      projectFiles: [{ filePath: "src/save.ts", source: dualSource }],
    }, evaluator);
    expect(dual.judgments.map(({ ruleId }) => ruleId)).toEqual([RULE]);
    expect(dual.judgments[0]).toMatchObject({
      probability: 0.73,
      evidence: expect.objectContaining({
        handlers: [expect.objectContaining({
          logsCaughtError: true,
          propagatesCaughtError: true,
        })],
      }),
    });
    expect(dual.abstentions).toEqual([]);

    const logOnlySource = `import { logger } from "./services.js";
export async function save(value: string) {
  try {
    await write(value);
  } catch (error) {
    logger.error("save failed", { error });
    return null;
  }
}
`;
    const logOnly = await analyzeFileWithFailures({
      filePath: "src/save.ts",
      source: logOnlySource,
      changedLines: [{ start: 1, end: 9 }],
      config,
      projectFiles: [{ filePath: "src/save.ts", source: logOnlySource }],
    }, evaluator);
    expect(logOnly.judgments).toEqual([]);
    expect(logOnly.abstentions).toEqual([
      { ruleId: RULE, candidateKind: "function", count: 1 },
    ]);
  });
});
