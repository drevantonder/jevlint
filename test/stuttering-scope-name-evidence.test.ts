import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { Visitor } from "oxc-parser";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { parseCached } from "../src/evidence/parse-cache.js";
import {
  buildStutteringScopeNameEvidence,
  tokenizeName,
} from "../src/evidence/stuttering-scope-name.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const RULE = "jev/no-stuttering-scope-name";
const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function methodCandidate(files: ProjectFile[], filePath: string, method: string): Candidate {
  const file = files.find((entry) => entry.filePath === filePath);
  expect(file).toBeDefined();
  if (!file) throw new Error(`Fixture has no file ${filePath}.`);
  let range: { start: number; end: number } | undefined;
  new Visitor({
    MethodDefinition(node) {
      const key = node.key;
      const name = key.type === "Identifier" ? key.name : null;
      if (name === method) range = { start: node.value.start, end: node.value.end };
    },
  }).visit(parseCached(file.filePath, file.source).program);
  expect(range).toBeDefined();
  if (!range) throw new Error(`Fixture has no method ${method}.`);
  const methodRange = range;
  const candidate = extractCandidates(file.filePath, file.source)
    .find(({ kind, start, end }) => kind === "function" && start === methodRange.start && end === methodRange.end);
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error(`Fixture has no candidate for ${method}.`);
  return candidate;
}

function functionCandidate(files: ProjectFile[], snippet: string): Candidate {
  const candidates = files.flatMap((file) =>
    extractCandidates(file.filePath, file.source)
      .map((candidate) => ({ candidate, file }))
  );
  const hit = candidates.find(({ candidate }) =>
    candidate.kind === "function" && candidate.source.includes(snippet)
  );
  expect(hit).toBeDefined();
  if (!hit) throw new Error(`Fixture has no function containing ${snippet}.`);
  return hit.candidate;
}

class RecordingEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.82]));
  }
}

describe("stuttering scope name evidence", () => {
  it("keeps its proposition untouched while gaining a builder", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({
      scope: "function",
      question: expect.objectContaining({
        instructions: expect.objectContaining({
          question: "Does this function name repeat its enclosing scope's vocabulary so the qualified use site stutters?",
        }),
      }),
      message: "This name repeats its enclosing scope's vocabulary.",
    });
  });

  it("fires for a method repeating its class name with siblings and qualified uses", async () => {
    const files = await project("stuttering-scope-name-smelly", [
      "src/config.ts",
      "src/app.ts",
    ]);

    const result = buildRuleEvidence(RULE, methodCandidate(files, "src/config.ts", "configPath"), files);

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
    if (!result.handled) return;
    expect(result.evidence).toMatchObject({
      function: { name: "configPath", nameTokens: ["config", "path"] },
      scope: { className: "Config", fileStem: "config" },
      sharedTokens: ["config"],
      siblings: [
        expect.objectContaining({ name: "configDir", sharedTokens: ["config"] }),
      ],
      qualifiedUses: [
        expect.objectContaining({ object: "config", member: "configPath" }),
      ],
    });
  });

  it("fires for a top-level function repeating its file stem", () => {
    const source = "export function configPath(name: string): string {\n"
      + "  return name;\n"
      + "}\n"
      + "export function resolveAlias(name: string): string {\n"
      + "  return name;\n"
      + "}\n";
    const files: ProjectFile[] = [{ filePath: "config/config.ts", source }];
    const candidate = extractCandidates("config/config.ts", source)
      .filter(({ kind }) => kind === "function")
      .find(({ source: text }) => text.includes("configPath"));
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildStutteringScopeNameEvidence(candidate, files)).toMatchObject({
      function: { name: "configPath" },
      scope: { className: null, fileStem: "config", qualifier: "config" },
      sharedTokens: expect.arrayContaining(["config"]),
    });
  });

  it("tokenizes camel, snake, and kebab scope names", () => {
    expect(tokenizeName("configPath")).toEqual(["config", "path"]);
    expect(tokenizeName("Config_Dir")).toEqual(["config", "dir"]);
    expect(tokenizeName("user-profile")).toEqual(["user", "profile"]);
  });

  it("abstains when the name shares no scope token", async () => {
    const files = await project("stuttering-scope-name-smelly", ["src/paths.ts"]);

    expect(buildStutteringScopeNameEvidence(methodCandidate(files, "src/paths.ts", "resolve"), files))
      .toBeUndefined();
  });

  it("abstains for anonymous functions", async () => {
    const files = await project("stuttering-scope-name-smelly", ["src/anonymous.ts"]);

    expect(
      buildStutteringScopeNameEvidence(functionCandidate(files, "values.map"), files),
    ).toBeUndefined();
  });

  it("abstains for non-function candidates", async () => {
    const files = await project("stuttering-scope-name-smelly", ["src/config.ts"]);
    const candidate = extractCandidates(files[0]?.filePath ?? "", files[0]?.source ?? "")
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildStutteringScopeNameEvidence(candidate, files)).toBeUndefined();
  });

  it("sends the stutter evidence to evaluation and reports the raw score", async () => {
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const evaluator = new RecordingEvaluator();

    const source = "export class Config {\n"
      + "  configPath(name: string): string {\n"
      + "    return name;\n"
      + "  }\n"
      + "}\n";
    const outcome = await analyzeFileWithFailures({
      filePath: "src/config.ts",
      source,
      changedLines: [{ start: 1, end: 5 }],
      config,
      projectFiles: [{ filePath: "src/config.ts", source }],
    }, evaluator);

    expect(outcome.judgments.map(({ ruleId }) => ruleId)).toEqual([RULE]);
    expect(outcome.judgments[0]?.probability).toBe(0.82);
    const stated = evaluator.requests[0]?.state.candidates[0]?.evidence?.[RULE];
    expect(stated).toMatchObject({
      sharedTokens: ["config"],
      scope: expect.objectContaining({ className: "Config" }),
    });
  });

  it("abstains structurally when nothing repeats the scope", async () => {
    const rule = defaultConfig.rules[RULE];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { [RULE]: rule } };
    const evaluator = new RecordingEvaluator();

    const source = "export class Router {\n"
      + "  resolve(path: string): string {\n"
      + "    return path;\n"
      + "  }\n"
      + "}\n";
    const outcome = await analyzeFileWithFailures({
      filePath: "src/paths.ts",
      source,
      changedLines: [{ start: 1, end: 5 }],
      config,
      projectFiles: [{ filePath: "src/paths.ts", source }],
    }, evaluator);

    expect(outcome.judgments).toEqual([]);
    expect(evaluator.requests).toEqual([]);
    expect(outcome.abstentions).toEqual([
      { ruleId: RULE, candidateKind: "function", count: 1 },
    ]);
  });
});
