import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CachedEvaluator } from "../src/cache.js";
import type { CachedEvaluatorOptions, EvaluatorIdentity } from "../src/cache.js";
import type { EvaluationRequest, Evaluator } from "../src/types.js";

const identity: EvaluatorIdentity = {
  provider: "test-provider",
  endpoint: "https://example.test",
  model: "jev-test-1",
  sdk: "test-sdk@1",
  evaluator: "test-evaluator-v1",
};

class CountingEvaluator implements Evaluator {
  readonly requests: EvaluationRequest[] = [];

  constructor(private readonly delay = 0) {}

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    if (this.delay > 0) await new Promise((resolve) => setTimeout(resolve, this.delay));
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.73]));
  }
}

function request(
  source = "function wrap(value) { return target(value); }",
  evidence = "one caller",
  ruleId = "jev/no-pass-through-wrapper",
  prompt = "Is this an unnecessary wrapper?",
  schema = "jevlint-semantic-judgment-v1",
): EvaluationRequest {
  return {
    state: {
      file: { path: "src/wrapper.ts" },
      candidates: [{
        id: "candidate_0",
        kind: "function",
        source,
        nearbySource: source,
        startLine: 1,
        endLine: 1,
        evidence: { [ruleId]: { repository: evidence } },
      }],
    },
    questions: {
      q0: {
        type: "noul",
        instructions: {
          schema,
          ruleId,
          question: prompt,
          inspect: "candidates[0]",
          context: "candidates[0].nearbySource",
          evidence: `candidates[0].evidence["${ruleId}"]`,
        },
        criteria: {
          true: "No policy is added",
          false: "The wrapper owns policy",
        },
      },
    },
  };
}

async function options(directory: string): Promise<CachedEvaluatorOptions> {
  return {
    directory,
    repository: "/canonical/repository/a",
    identity,
  };
}

async function cacheFiles(directory: string): Promise<string[]> {
  const paths = await readdir(directory, { recursive: true });
  return paths.filter((path) => path.endsWith(".json")).map((path) => join(directory, path));
}

describe("CachedEvaluator", () => {
  it("reuses each semantic judgment while candidate discovery still supplies the request", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevlint-cache-"));
    const delegate = new CountingEvaluator();
    const evaluator = new CachedEvaluator(delegate, await options(directory));

    await expect(evaluator.evaluate(request())).resolves.toEqual({ q0: 0.73 });
    await expect(evaluator.evaluate(request())).resolves.toEqual({ q0: 0.73 });

    expect(delegate.requests).toHaveLength(1);
    expect(evaluator.statistics).toMatchObject({ hits: 1, misses: 1, writes: 1 });
  });

  it("misses when any semantic input or evaluator identity changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevlint-cache-inputs-"));
    const delegate = new CountingEvaluator();
    const evaluator = new CachedEvaluator(delegate, await options(directory));

    await evaluator.evaluate(request());
    await evaluator.evaluate(request("function wrap(value) { return other(value); }"));
    await evaluator.evaluate(request(undefined, "two callers"));
    await evaluator.evaluate(request(undefined, undefined, "personal/no-wrapper"));
    await evaluator.evaluate(request(undefined, undefined, undefined, "Does this add no value?"));
    await evaluator.evaluate(request(undefined, undefined, undefined, undefined, "schema-v2"));

    const criteriaChange = request();
    criteriaChange.questions.q0 = {
      type: "noul",
      instructions: criteriaChange.questions.q0?.instructions ?? "",
      criteria: { true: "Pure delegation", false: "Owns a boundary" },
    };
    await evaluator.evaluate(criteriaChange);

    const identities: EvaluatorIdentity[] = [
      { ...identity, provider: "other-provider" },
      { ...identity, endpoint: "https://other.example.test" },
      { ...identity, model: "jev-test-2" },
      { ...identity, sdk: "test-sdk@2" },
      { ...identity, evaluator: "test-evaluator-v2" },
    ];
    for (const changedIdentity of identities) {
      const changedEvaluator = new CachedEvaluator(delegate, {
        ...await options(directory),
        identity: changedIdentity,
      });
      await changedEvaluator.evaluate(request());
    }

    const otherRepository = new CachedEvaluator(delegate, {
      ...await options(directory),
      repository: "/canonical/repository/b",
    });
    await otherRepository.evaluate(request());

    expect(delegate.requests).toHaveLength(13);
  });

  it("misses when file or candidate context changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevlint-cache-context-"));
    const delegate = new CountingEvaluator();
    const evaluator = new CachedEvaluator(delegate, await options(directory));
    await evaluator.evaluate(request());

    const changedPath = request();
    changedPath.state.file.path = "src/other.ts";
    await evaluator.evaluate(changedPath);

    const changedId = request();
    changedId.state.candidates[0]!.id = "candidate_1";
    await evaluator.evaluate(changedId);

    const changedKind = request();
    changedKind.state.candidates[0]!.kind = "comment";
    await evaluator.evaluate(changedKind);

    const changedContext = request();
    changedContext.state.candidates[0]!.nearbySource = "const context = true;";
    await evaluator.evaluate(changedContext);

    const changedLines = request();
    changedLines.state.candidates[0]!.endLine = 2;
    await evaluator.evaluate(changedLines);

    expect(delegate.requests).toHaveLength(6);
  });

  it("canonicalizes object key order and ignores question map IDs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevlint-cache-canonical-"));
    const delegate = new CountingEvaluator();
    const evaluator = new CachedEvaluator(delegate, await options(directory));
    const first = request(undefined, "same");
    const second = request(undefined, "same");
    first.state.candidates[0]!.evidence = { rule: { alpha: "a", beta: "b" } };
    second.state.candidates[0]!.evidence = { rule: { beta: "b", alpha: "a" } };

    await evaluator.evaluate(first);
    await evaluator.evaluate(second);
    const originalQuestion = second.questions.q0;
    expect(originalQuestion).toBeDefined();
    if (!originalQuestion) return;
    second.questions = { renumbered: originalQuestion };
    await expect(evaluator.evaluate(second)).resolves.toEqual({ renumbered: 0.73 });

    expect(delegate.requests).toHaveLength(1);
  });

  it("treats malformed entries as misses and replaces them", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevlint-cache-malformed-"));
    const delegate = new CountingEvaluator();
    await new CachedEvaluator(delegate, await options(directory)).evaluate(request());
    const [path] = await cacheFiles(directory);
    expect(path).toBeDefined();
    if (!path) return;
    await writeFile(path, "not json");

    const evaluator = new CachedEvaluator(delegate, await options(directory));
    await evaluator.evaluate(request());

    expect(delegate.requests).toHaveLength(2);
    expect(evaluator.statistics.recoveries).toBe(1);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ probability: 0.73 });
  });

  it("supports disabled and refresh modes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevlint-cache-modes-"));
    const delegate = new CountingEvaluator();
    const baseOptions = await options(directory);
    const disabled = new CachedEvaluator(delegate, { ...baseOptions, mode: "disabled" });

    await disabled.evaluate(request());
    await disabled.evaluate(request());
    expect(delegate.requests).toHaveLength(2);
    await expect(cacheFiles(directory)).resolves.toEqual([]);

    const normal = new CachedEvaluator(delegate, baseOptions);
    await normal.evaluate(request());
    const refresh = new CachedEvaluator(delegate, { ...baseOptions, mode: "refresh" });
    await refresh.evaluate(request());
    expect(delegate.requests).toHaveLength(4);

    await new CachedEvaluator(delegate, baseOptions).evaluate(request());
    expect(delegate.requests).toHaveLength(4);
  });

  it("coalesces concurrent misses and leaves one complete atomic file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevlint-cache-concurrent-"));
    const delegate = new CountingEvaluator(20);
    const evaluator = new CachedEvaluator(delegate, await options(directory));

    const results = await Promise.all(Array.from({ length: 8 }, () => evaluator.evaluate(request())));

    expect(results).toEqual(Array.from({ length: 8 }, () => ({ q0: 0.73 })));
    expect(delegate.requests).toHaveLength(1);
    const paths = await readdir(directory, { recursive: true });
    expect(paths.filter((path) => path.endsWith(".json"))).toHaveLength(1);
    expect(paths.some((path) => path.endsWith(".tmp"))).toBe(false);
  });

  it("persists only the probability and content digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jevlint-cache-secrets-"));
    const marker = "TYPESAFE_API_KEY=do-not-persist-this";
    const delegate = new CountingEvaluator();
    await new CachedEvaluator(delegate, await options(directory)).evaluate(request(marker));
    const [path] = await cacheFiles(directory);
    expect(path).toBeDefined();
    if (!path) return;

    const stored = await readFile(path, "utf8");
    expect(stored).not.toContain(marker);
    expect(stored).not.toContain("TYPESAFE_API_KEY");
    expect(stored).toContain('"probability":0.73');
  });
});
