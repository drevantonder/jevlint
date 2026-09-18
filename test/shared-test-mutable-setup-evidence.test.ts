import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildSharedTestMutableSetupEvidence } from "../src/evidence/shared-test-mutable-setup.js";
import type {
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function testCandidate(owner: ProjectFile, snippet: string) {
  return extractCandidates(owner.filePath, owner.source)
    .filter(({ kind, source }) => kind === "function" && source.includes(snippet))
    .sort((left, right) => left.source.length - right.source.length)[0];
}

class FixedScoreEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];

  constructor(private readonly score: number) {}

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, this.score]));
  }
}

function ruleOnlyConfig(): JevLintConfig | undefined {
  const rule = defaultConfig.rules["jev/no-shared-test-mutable-setup"];
  if (!rule) return undefined;
  return { rules: { "jev/no-shared-test-mutable-setup": rule } };
}

describe("shared test mutable setup evidence", () => {
  it("reports cross-test flows for a test reading beforeAll-assigned state", async () => {
    const projectFiles = await project("shared-setup-positive", ["test/cart.test.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "toHaveLength(0)");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSharedTestMutableSetupEvidence(candidate, projectFiles)).toMatchObject({
      function: { title: "starts empty" },
      sharedVariables: expect.arrayContaining([
        expect.objectContaining({ name: "cart", declaredIn: "module scope" }),
        expect.objectContaining({ name: "attempts", declaredIn: expect.stringContaining("describe") }),
      ]),
      flows: expect.arrayContaining([
        expect.objectContaining({
          variable: "cart",
          writtenIn: "beforeAll",
          readIn: 'test "starts empty"',
          writeKind: "assign",
        }),
        expect.objectContaining({
          variable: "attempts",
          writtenIn: "beforeAll",
          readIn: 'test "starts empty"',
        }),
      ]),
      tests: 2,
    });
  });

  it("reports flows for a test writing state another case reads", async () => {
    const projectFiles = await project("shared-setup-positive", ["test/cart.test.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = testCandidate(owner, "cart.push");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSharedTestMutableSetupEvidence(candidate, projectFiles)).toMatchObject({
      function: { title: "records an attempt" },
      flows: expect.arrayContaining([
        expect.objectContaining({
          variable: "cart",
          writtenIn: 'test "records an attempt"',
          readIn: 'test "starts empty"',
          writeKind: "mutate",
        }),
      ]),
    });
  });

  it("abstains when beforeEach resets shared state and cases arrange locally", async () => {
    const projectFiles = await project("shared-setup-negative", ["test/cart.test.ts"]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    for (const snippet of ["toHaveLength(1)", "const local"]) {
      const candidate = testCandidate(owner, snippet);
      expect(candidate).toBeDefined();
      if (!candidate) return;
      expect(buildSharedTestMutableSetupEvidence(candidate, projectFiles)).toBeUndefined();
    }
  });

  it("abstains for production files", async () => {
    const projectFiles = await project("shared-setup-positive", [
      "test/cart.test.ts",
      "src/cart.ts",
    ]);
    const owner = projectFiles[1];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = extractCandidates(owner.filePath, owner.source)
      .find(({ kind }) => kind === "function");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSharedTestMutableSetupEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when the file holds a single case", async () => {
    const projectFiles: ProjectFile[] = [{
      filePath: "test/single.test.ts",
      source: "import { expect, it } from \"vitest\";\n"
        + "let cache: string[];\n"
        + "it(\"holds one value\", () => {\n"
        + "  cache = [\"a\"];\n"
        + "  expect(cache).toHaveLength(1);\n"
        + "});\n",
    }];
    const owner = projectFiles[0];
    if (!owner) return;
    const candidate = testCandidate(owner, "toHaveLength(1)");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildSharedTestMutableSetupEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("emits judgments carrying evidence content with raw evaluator scores", async () => {
    const config = ruleOnlyConfig();
    expect(config).toBeDefined();
    if (!config) return;
    const projectFiles = await project("shared-setup-positive", [
      "test/cart.test.ts",
      "src/cart.ts",
    ]);
    const file = projectFiles[0];
    expect(file).toBeDefined();
    if (!file) return;
    const changedLines = [{ start: 1, end: file.source.split("\n").length }];

    for (const score of [0.83, 0.14]) {
      const evaluator = new FixedScoreEvaluator(score);
      const judgments = await analyzeFile({
        filePath: file.filePath,
        source: file.source,
        changedLines,
        config,
        projectFiles,
      }, evaluator);
      expect(judgments).toContainEqual(expect.objectContaining({
        ruleId: "jev/no-shared-test-mutable-setup",
        probability: score,
        evidence: expect.objectContaining({
          function: expect.objectContaining({ title: "starts empty" }),
          flows: expect.arrayContaining([
            expect.objectContaining({
              variable: "cart",
              writtenIn: "beforeAll",
              readIn: 'test "starts empty"',
            }),
          ]),
        }),
      }));
    }
  });
});
