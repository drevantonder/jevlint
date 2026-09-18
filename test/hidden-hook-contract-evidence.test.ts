import { describe, expect, it } from "vitest";
import { analyzeFileWithFailures } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/defaults.js";
import { buildHiddenHookContractEvidence } from "../src/evidence/hidden-hook-contract.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const SMELLY = "import { useState } from \"react\";\n"
  + "export function getUser(id: string): string {\n"
  + "  const [name] = useState(\"ada\");\n"
  + "  return `${name}:${id}`;\n"
  + "}\n";

const TRANSITIVE = "import { useState } from \"react\";\n"
  + "function useStoredName(): string {\n"
  + "  const [name] = useState(\"ada\");\n"
  + "  return name;\n"
  + "}\n"
  + "export function loadGreeting(id: string): string {\n"
  + "  return `hi ${useStoredName()}:${id}`;\n"
  + "}\n";

const CONDITIONAL_CALLER = "import { getUser } from \"./user.js\";\n"
  + "export function greet(id: string, loud: boolean): string {\n"
  + "  if (loud) {\n"
  + "    return getUser(id).toUpperCase();\n"
  + "  }\n"
  + "  return getUser(id);\n"
  + "}\n";

function candidateFor(filePath: string, source: string, snippet: string): Candidate {
  const candidate = extractCandidates(filePath, source)
    .filter(({ kind }) => kind === "function")
    .find(({ source: text }) => text.includes(snippet));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no candidate.");
  return candidate;
}

describe("hidden hook contract evidence", () => {
  it("flags a plain-named function calling a hook directly", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/user.ts", source: SMELLY }];

    const evidence = buildHiddenHookContractEvidence(
      candidateFor("src/user.ts", SMELLY, "getUser"),
      projectFiles,
    );

    expect(evidence).toMatchObject({
      function: { name: "getUser" },
      hookCalls: [
        expect.objectContaining({ callee: "useState", nested: false }),
      ],
    });
  });

  it("resolves a transitive call into a local genuine hook", () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/greeting.ts", source: TRANSITIVE }];

    const evidence = buildHiddenHookContractEvidence(
      candidateFor("src/greeting.ts", TRANSITIVE, "loadGreeting"),
      projectFiles,
    );

    expect(evidence).toMatchObject({
      function: { name: "loadGreeting" },
      hookCalls: [
        expect.objectContaining({ callee: "useStoredName" }),
      ],
      calleeResolutions: [
        expect.objectContaining({
          callee: "useStoredName",
          localDefinition: true,
          definitionCallsHooks: true,
        }),
      ],
    });
  });

  it("marks a hook call inside a nested closure", () => {
    const source = "import { useState } from \"react\";\n"
      + "export function getCounter(): () => number {\n"
      + "  let count = 0;\n"
      + "  return () => {\n"
      + "    const [step] = useState(1);\n"
      + "    count += step;\n"
      + "    return count;\n"
      + "  };\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/counter.ts", source }];

    expect(buildHiddenHookContractEvidence(
      candidateFor("src/counter.ts", source, "getCounter"),
      projectFiles,
    )).toMatchObject({
      hookCalls: [
        expect.objectContaining({ callee: "useState", nested: true }),
      ],
    });
  });

  it("corroborates a caller invoking the function inside a condition", () => {
    const projectFiles: ProjectFile[] = [
      { filePath: "src/user.ts", source: SMELLY },
      { filePath: "src/greet.ts", source: CONDITIONAL_CALLER },
    ];

    const evidence = buildHiddenHookContractEvidence(
      candidateFor("src/user.ts", SMELLY, "getUser"),
      projectFiles,
    );

    expect(evidence?.callers).toEqual(
      expect.arrayContaining([expect.objectContaining({ filePath: "src/greet.ts" })]),
    );
    expect(evidence?.riskyCallers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filePath: "src/greet.ts", context: "conditional" }),
      ]),
    );
  });

  it("abstains for a declared use*-prefixed custom hook", () => {
    const source = "import { useState } from \"react\";\n"
      + "export function useUser(id: string): string {\n"
      + "  const [name] = useState(\"ada\");\n"
      + "  return `${name}:${id}`;\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/user.ts", source }];

    expect(buildHiddenHookContractEvidence(
      candidateFor("src/user.ts", source, "useUser"),
      projectFiles,
    )).toBeUndefined();
  });

  it("abstains for a Capitalized component", () => {
    const source = "import { useState } from \"react\";\n"
      + "export function UserCard({ id }: { id: string }): string {\n"
      + "  const [name] = useState(\"ada\");\n"
      + "  return `${name}:${id}`;\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/card.ts", source }];

    expect(buildHiddenHookContractEvidence(
      candidateFor("src/card.ts", source, "UserCard"),
      projectFiles,
    )).toBeUndefined();
  });

  it("abstains when the only use* callee is a prefix-sharing plain helper", () => {
    const source = "function useCacheKey(key: string): string {\n"
      + "  return `cache:${key}`;\n"
      + "}\n"
      + "export function cacheKeyFor(key: string): string {\n"
      + "  return useCacheKey(key);\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/cache.ts", source }];

    expect(buildHiddenHookContractEvidence(
      candidateFor("src/cache.ts", source, "cacheKeyFor"),
      projectFiles,
    )).toBeUndefined();
  });

  it("abstains when the function merely receives a hook result as an argument", () => {
    const source = "import { useUser } from \"./hooks.js\";\n"
      + "export function formatUser(name: string): string {\n"
      + "  return name.trim().toLowerCase();\n"
      + "}\n"
      + "export function greeting(): string {\n"
      + "  return formatUser(useUser());\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/format.ts", source }];

    expect(buildHiddenHookContractEvidence(
      candidateFor("src/format.ts", source, "formatUser"),
      projectFiles,
    )).toBeUndefined();
  });

  it("abstains when no hook call exists and for non-function candidates", () => {
    const source = "export interface User {\n"
      + "  name: string;\n"
      + "}\n"
      + "export function formatUser(name: string): string {\n"
      + "  return name.trim();\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/format.ts", source }];

    expect(buildHiddenHookContractEvidence(
      candidateFor("src/format.ts", source, "formatUser"),
      projectFiles,
    )).toBeUndefined();

    const face = extractCandidates("src/format.ts", source)[0];
    expect(face).toBeDefined();
    if (!face) return;
    expect(buildHiddenHookContractEvidence(face, projectFiles)).toBeUndefined();
  });

  it("carries hook-call evidence through a fake evaluator with raw scores", async () => {
    const projectFiles: ProjectFile[] = [{ filePath: "src/user.ts", source: SMELLY }];
    const rule = defaultConfig.rules["jev/no-hidden-hook-contract"];
    expect(rule).toBeDefined();
    if (!rule) return;
    const config: JevLintConfig = { rules: { "jev/no-hidden-hook-contract": rule } };
    const evaluator: Evaluator = {
      async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
        return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.82]));
      },
    };

    const result = await analyzeFileWithFailures({
      filePath: "src/user.ts",
      source: SMELLY,
      changedLines: [{ start: 1, end: SMELLY.split("\n").length }],
      config,
      projectFiles,
    }, evaluator);

    expect(result.failures).toEqual([]);
    expect(result.judgments.map((judgment) => judgment.probability)).toEqual([0.82]);
    const judged = result.judgments[0];
    expect(judged?.ruleId).toBe("jev/no-hidden-hook-contract");
    // SAFETY: rule evidence is a JSON object and this builder sets hookCalls on every firing.
    const evidence = judged?.evidence as {
      hookCalls?: { callee: string; nested: boolean }[];
    } | null;
    expect(evidence?.hookCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ callee: "useState", nested: false }),
      ]),
    );
  });
});
