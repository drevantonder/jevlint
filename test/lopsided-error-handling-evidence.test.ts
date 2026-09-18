import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildLopsidedErrorHandlingEvidence } from "../src/evidence/lopsided-error-handling.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const RULE = "jev/no-lopsided-error-handling";
const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function load(repository: string, filePath: string): Promise<ProjectFile> {
  return {
    filePath,
    source: await readFile(new URL(`${repository}/${filePath}`, repositories), "utf8"),
  };
}

describe("lopsided error handling evidence", () => {
  it("shows Jev the guarded and bare siblings of the same kind", async () => {
    const owner = await load("lopsided-error-smelly", "src/orders.ts");
    const projectFiles = [owner];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find((item) => item.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    const evidence = buildLopsidedErrorHandlingEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "fulfillOrder" },
      groups: [
        expect.objectContaining({
          kind: "await:db",
          guarded: expect.arrayContaining([
            expect.objectContaining({ call: expect.stringContaining("fetchOrder") }),
            expect.objectContaining({ call: expect.stringContaining("charge") }),
          ]),
          unguarded: [expect.objectContaining({ call: expect.stringContaining("ship") })],
        }),
      ],
      outerHandlerCoversBody: false,
    });
  });

  it("abstains when one outer handler covers the whole body", async () => {
    const owner = await load("lopsided-error-uniform", "src/orders.ts");
    const projectFiles = [owner];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find((item) => item.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildLopsidedErrorHandlingEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when there are no fallible operations to compare", () => {
    const source = "export function total(items: number[]) { return items.reduce((a, b) => a + b, 0); }";
    const candidate = extractCandidates("src/total.ts", source)
      .find((item) => item.kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildLopsidedErrorHandlingEvidence(candidate, [{ filePath: "src/total.ts", source }]))
      .toBeUndefined();
  });

  it("treats a bare returned failure value as handling, not a bare sibling", async () => {
    const owner = await load("lopsided-error-returnfail", "src/submit.ts");
    const projectFiles = [owner];
    const candidate = functionCandidate(owner, "submit");

    const evidence = buildLopsidedErrorHandlingEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "submit" },
      outerHandlerCoversBody: false,
    });
    expect(evidence?.groups.map((group) => group.kind)).toEqual(["await:db"]);
    expect(evidence?.groups[0]).toMatchObject({
      guarded: [
        expect.objectContaining({ call: expect.stringContaining("fetchOrder") }),
        expect.objectContaining({ call: expect.stringContaining("charge") }),
      ],
      unguarded: [expect.objectContaining({ call: expect.stringContaining("ship") })],
    });
    expect(evidence?.groups.some((group) => group.kind.includes("fail"))).toBe(false);
  });

  it("ships return-fail evidence to Jev with raw scores and no cutoffs", async () => {
    const rule = defaultConfig.rules[RULE];
    expect(rule).toMatchObject({ scope: "function", message: expect.any(String) });
    expect(rule).not.toHaveProperty("threshold");
    expect(rule).not.toHaveProperty("severity");
    if (!rule) return;
    const owner = await load("lopsided-error-returnfail", "src/submit.ts");
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const evaluator = new StubEvaluator(0.37);

    const result = await analyzeFileWithFailures({
      filePath: owner.filePath,
      source: owner.source,
      changedLines: [{ start: 1, end: owner.source.split("\n").length }],
      config,
      projectFiles: [owner],
    }, evaluator);

    expect(result.judgments.map(({ ruleId }) => ruleId)).toEqual([RULE]);
    expect(result.judgments[0]?.probability).toBe(0.37);
    expect(result.abstentions).toEqual([]);
    expect(result.failures).toEqual([]);
  });

  it("abstains when every failure value is returned", () => {
    const source = `import { fail } from "./respond.js";
export async function setup(orderId: string): Promise<unknown> {
  try {
    await prepare(orderId);
  } catch {
    return fail(400, { step: "setup" });
  }
  return fail(200, { step: "done" });
}`;
    const candidate = functionCandidate({ filePath: "src/setup.ts", source }, "setup");

    expect(buildLopsidedErrorHandlingEvidence(candidate, [{ filePath: "src/setup.ts", source }]))
      .toBeUndefined();
  });

  it("marks returned failure values on the handled side when a group still forms", () => {
    const source = `import { fail } from "./respond.js";
export function submit(ok: boolean): unknown {
  if (ok) {
    return fail(400, { billed: true });
  }
  fail(500, { billed: false });
  return { ok: false };
}`;
    const candidate = functionCandidate({ filePath: "src/submit.ts", source }, "submit");

    const evidence = buildLopsidedErrorHandlingEvidence(candidate, [{ filePath: "src/submit.ts", source }]);

    expect(evidence?.groups.map((group) => group.kind)).toEqual(["call:fail"]);
    expect(evidence?.groups[0]?.guarded).toHaveLength(1);
    expect(evidence?.groups[0]?.guarded[0]).toMatchObject({ guarded: false, handledByReturn: true });
    expect(evidence?.groups[0]?.unguarded).toHaveLength(1);
    expect(evidence?.groups[0]?.unguarded[0]).toMatchObject({ guarded: false, handledByReturn: false });
  });

  it("abstains when the bare sibling is provably safe", async () => {
    const owner = await load("lopsided-error-dryrun", "src/search.ts");
    const candidate = functionCandidate(owner, "search");

    expect(buildLopsidedErrorHandlingEvidence(candidate, [owner])).toBeUndefined();
  });

  it("emits when the bare sibling can throw over the network", async () => {
    const owner = await load("lopsided-error-liveask", "src/search.ts");
    const candidate = functionCandidate(owner, "search");

    const evidence = buildLopsidedErrorHandlingEvidence(candidate, [owner]);

    expect(evidence).toMatchObject({
      function: { name: "search" },
      groups: [
        expect.objectContaining({
          kind: "await:liveAsk",
          guarded: [expect.objectContaining({ call: expect.stringContaining("liveAsk") })],
          unguarded: [expect.objectContaining({ call: expect.stringContaining("liveAsk") })],
        }),
      ],
      lowRisk: [],
      outerHandlerCoversBody: false,
    });
  });

  it("sends the live sibling to evaluation and abstains the dry-run sibling", async () => {
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const evaluator = new StubEvaluator(0.62);

    const live = await load("lopsided-error-liveask", "src/search.ts");
    const liveResult = await analyzeFileWithFailures({
      filePath: live.filePath,
      source: live.source,
      changedLines: [{ start: 1, end: live.source.split("\n").length }],
      config,
      projectFiles: [live],
    }, evaluator);
    expect(liveResult.judgments.map(({ ruleId }) => ruleId)).toEqual([RULE]);
    expect(liveResult.judgments[0]?.probability).toBe(0.62);
    expect(liveResult.failures).toEqual([]);

    const dry = await load("lopsided-error-dryrun", "src/search.ts");
    const dryResult = await analyzeFileWithFailures({
      filePath: dry.filePath,
      source: dry.source,
      changedLines: [{ start: 1, end: dry.source.split("\n").length }],
      config,
      projectFiles: [dry],
    }, evaluator);
    expect(dryResult.judgments).toEqual([]);
    expect(dryResult.abstentions).toEqual([
      { ruleId: RULE, candidateKind: "function", count: 2 },
    ]);
    expect(dryResult.failures).toEqual([]);
  });

  it("treats unresolvable callees as can-throw", () => {
    const source = `import { ask } from "./service.js";
export async function search(query: string): Promise<string> {
  let first: string;
  try {
    first = await ask(query);
  } catch {
    first = "fallback";
  }
  const second = await ask(query);
  return first + second;
}`;
    const candidate = functionCandidate({ filePath: "src/search.ts", source }, "search");

    const evidence = buildLopsidedErrorHandlingEvidence(candidate, [{ filePath: "src/search.ts", source }]);

    expect(evidence?.groups.map((group) => group.kind)).toEqual(["await:ask"]);
  });

  it("treats recursive callees as can-throw instead of recursing forever", () => {
    const source = `function ask(query: string): string {
  return query.length > 0 ? ask(query.slice(1)) : query;
}
export function search(query: string): string {
  let first: string;
  try {
    first = ask(query);
  } catch {
    first = "fallback";
  }
  const second = ask(query);
  return first + second;
}`;
    const candidate = functionCandidate({ filePath: "src/search.ts", source }, "search");

    const evidence = buildLopsidedErrorHandlingEvidence(candidate, [{ filePath: "src/search.ts", source }]);

    expect(evidence?.groups.map((group) => group.kind)).toEqual(["call:ask"]);
  });

  it("records provably-safe calls as low-risk facts alongside genuine groups", () => {
    const source = `import { db } from "./db.js";
function dryAsk(query: string): string {
  return "dry-run:" + query;
}
export async function search(query: string): Promise<string> {
  let first: string;
  try {
    first = dryAsk(query);
  } catch {
    first = "fallback";
  }
  const second = dryAsk(query);
  let tracking;
  try {
    tracking = await db.fetchOrder(query);
  } catch {
    tracking = null;
  }
  const receipt = await db.ship(query);
  return first + second + receipt.id;
}`;
    const candidate = functionCandidate({ filePath: "src/search.ts", source }, "search");

    const evidence = buildLopsidedErrorHandlingEvidence(candidate, [{ filePath: "src/search.ts", source }]);

    expect(evidence?.groups.map((group) => group.kind)).toEqual(["await:db"]);
    expect(evidence?.lowRisk).toHaveLength(1);
    expect(evidence?.lowRisk[0]).toMatchObject({
      callee: "dryAsk",
      call: expect.stringContaining("dryAsk(query)"),
      reason: expect.stringContaining("no-throw-reach"),
    });
  });
});

function functionCandidate(owner: ProjectFile, name: string): Candidate {
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find((item) => item.kind === "function" && item.source.includes(name));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error(`Fixture has no function containing ${name}.`);
  return candidate;
}

class StubEvaluator implements Evaluator {
  constructor(private readonly probability: number) {}
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, this.probability]));
  }
}
