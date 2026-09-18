import { describe, expect, it } from "vitest";
import { analyzeFile } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildLoadBearingAsyncEvidence } from "../src/evidence/load-bearing-async.js";
import type { Evaluator, EvaluationRequest, JevLintConfig, ProjectFile } from "../src/types.js";

const OWNER = "export async function fetchUser(id: string): Promise<{ name: string }> {\n"
  + "  return getCached(id);\n"
  + "}\n"
  + "declare function getCached(id: string): { name: string };\n";

const CALLER = "import { fetchUser } from \"./users.js\";\n"
  + "export async function show(id: string): Promise<string> {\n"
  + "  const user = await fetchUser(id);\n"
  + "  return user.name;\n"
  + "}\n";

function project(ownerSource: string, callerSource?: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/users.ts", source: ownerSource }];
  if (callerSource !== undefined) {
    projectFiles.push({ filePath: "src/show.ts", source: callerSource });
  }
  const candidate = extractCandidates("src/users.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("fetchUser"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no fetchUser candidate.");
  return { candidate, projectFiles };
}

describe("load-bearing async evidence", () => {
  it("reports an await-less async function awaited by callers", () => {
    const { candidate, projectFiles } = project(OWNER, CALLER);

    const evidence = buildLoadBearingAsyncEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "fetchUser", exported: true },
      callerUsage: {
        awaitingCallSites: [expect.stringContaining("fetchUser")],
      },
    });
  });

  it("abstains when the body already awaits", () => {
    const source = "import { readRemote } from \"./client.js\";\n"
      + "export async function fetchUser(id: string): Promise<string> {\n"
      + "  return readRemote(id);\n"
      + "}\n"
      + "export async function fetchDirect(id: string): Promise<string> {\n"
      + "  return await readRemote(id);\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/users.ts", source }];
    const candidate = extractCandidates("src/users.ts", source)
      .filter(({ kind }) => kind === "function")
      .find(({ source: text }) => text.includes("fetchDirect"));
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("Fixture has no candidate.");

    expect(buildLoadBearingAsyncEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains for non-async functions", () => {
    const source = "export function fetchUser(id: string): string {\n"
      + "  return id;\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/users.ts", source }];
    const candidate = extractCandidates("src/users.ts", source)
      .filter(({ kind }) => kind === "function")
      .find(({ source: text }) => text.includes("fetchUser"));
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("Fixture has no candidate.");

    expect(buildLoadBearingAsyncEvidence(candidate, projectFiles)).toBeUndefined();
  });
});

const ASYNC_FINDER = "async function customFinder(id: string): Promise<string> {\n"
  + "  return id;\n"
  + "}\n";

const MIXED_OWNER = "export async function findUser(id: string): Promise<string> {\n"
  + "  if (id === \"guest\") return \"Guest\";\n"
  + "  return customFinder(id);\n"
  + "}\n"
  + ASYNC_FINDER;

const MIXED_CALLER = "import { findUser } from \"./users.js\";\n"
  + "export async function show(id: string): Promise<string> {\n"
  + "  return findUser(id);\n"
  + "}\n";

function findUserProject(ownerSource: string, extraFiles: ProjectFile[] = []) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/users.ts", source: ownerSource }, ...extraFiles];
  const candidate = extractCandidates("src/users.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("findUser"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no findUser candidate.");
  return { candidate, projectFiles };
}

describe("load-bearing async branch scan", () => {
  it("names the awaiting branch when one return hands an async finder's promise outward", () => {
    const { candidate, projectFiles } = findUserProject(MIXED_OWNER);

    const evidence = buildLoadBearingAsyncEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "findUser", exported: true },
      awaitingBranches: [expect.stringContaining("customFinder(id)")],
    });
  });

  it("names the awaiting arm of a returned ternary", () => {
    const source = "export async function findUser(id: string): Promise<string> {\n"
      + "  return id === \"guest\" ? \"Guest\" : customFinder(id);\n"
      + "}\n"
      + ASYNC_FINDER;
    const { candidate, projectFiles } = findUserProject(source);

    const evidence = buildLoadBearingAsyncEvidence(candidate, projectFiles);

    expect(evidence?.awaitingBranches).toEqual([expect.stringContaining("customFinder(id)")]);
  });

  it("names the awaiting arm of an arrow concise-body ternary", () => {
    const source = "export const findUser = async (id: string): Promise<string> => id === \"guest\" ? \"Guest\" : customFinder(id);\n"
      + ASYNC_FINDER;
    const projectFiles: ProjectFile[] = [{ filePath: "src/users.ts", source }];
    const candidate = extractCandidates("src/users.ts", source)
      .filter(({ kind }) => kind === "function")
      .find(({ source: text }) => text.includes("=>"));
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("Fixture has no candidate.");

    const evidence = buildLoadBearingAsyncEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "findUser" },
      awaitingBranches: [expect.stringContaining("customFinder(id)")],
    });
  });

  it("names the branch when the only return hands an async finder's promise outward", () => {
    const source = "export async function findUser(id: string): Promise<string> {\n"
      + "  return customFinder(id);\n"
      + "}\n"
      + ASYNC_FINDER;
    const { candidate, projectFiles } = findUserProject(source);

    const evidence = buildLoadBearingAsyncEvidence(candidate, projectFiles);

    expect(evidence?.awaitingBranches).toEqual([expect.stringContaining("customFinder(id)")]);
  });

  it("reports no awaiting branch when no return hands a promise outward", () => {
    const { candidate, projectFiles } = project(OWNER, CALLER);

    const evidence = buildLoadBearingAsyncEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({ awaitingBranches: [] });
  });

  it("reports no awaiting branch when the async call result is coerced before returning", () => {
    const source = "export async function findUser(id: string): Promise<string> {\n"
      + "  if (id === \"guest\") return \"Guest\";\n"
      + "  return String(customFinder(id));\n"
      + "}\n"
      + ASYNC_FINDER;
    const { candidate, projectFiles } = findUserProject(source);

    const evidence = buildLoadBearingAsyncEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({ awaitingBranches: [] });
  });

  it("reports no awaiting branch when the callee is sync", () => {
    const source = "export async function findUser(id: string): Promise<string> {\n"
      + "  if (id === \"guest\") return \"Guest\";\n"
      + "  return customFinder(id);\n"
      + "}\n"
      + "function customFinder(id: string): string {\n"
      + "  return id;\n"
      + "}\n";
    const { candidate, projectFiles } = findUserProject(source);

    const evidence = buildLoadBearingAsyncEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({ awaitingBranches: [] });
  });

  it("resolves an async finder through a project-local import", () => {
    const ownerSource = "import { customFinder } from \"./finder.js\";\n"
      + "export async function findUser(id: string): Promise<string> {\n"
      + "  if (id === \"guest\") return \"Guest\";\n"
      + "  return customFinder(id);\n"
      + "}\n";
    const finderSource = "export async function customFinder(id: string): Promise<string> {\n"
      + "  return id;\n"
      + "}\n";
    const { candidate, projectFiles } = findUserProject(ownerSource, [
      { filePath: "src/finder.ts", source: finderSource },
    ]);

    const evidence = buildLoadBearingAsyncEvidence(candidate, projectFiles);

    expect(evidence?.awaitingBranches).toEqual([expect.stringContaining("customFinder(id)")]);
  });

  it("reports no awaiting branch when the imported finder cannot be resolved", () => {
    const ownerSource = "import { customFinder } from \"./missing.js\";\n"
      + "export async function findUser(id: string): Promise<string> {\n"
      + "  if (id === \"guest\") return \"Guest\";\n"
      + "  return customFinder(id);\n"
      + "}\n";
    const { candidate, projectFiles } = findUserProject(ownerSource);

    const evidence = buildLoadBearingAsyncEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({ awaitingBranches: [] });
  });
});

describe("load-bearing async judgments with a fixed evaluator", () => {
  class FixedEvaluator implements Evaluator {
    constructor(private readonly probability: number) {}
    async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
      return Object.fromEntries(
        Object.keys(request.questions).map((id) => [id, this.probability]),
      );
    }
  }

  async function lint(source: string, projectFiles: ProjectFile[], probability: number) {
    const rule = defaultConfig.rules["jev/no-load-bearing-async"];
    expect(rule).toBeDefined();
    if (!rule) throw new Error("Rule jev/no-load-bearing-async is missing.");
    const config: JevLintConfig = { rules: { "jev/no-load-bearing-async": rule } };
    return analyzeFile({
      filePath: "src/users.ts",
      source,
      changedLines: [{ start: 1, end: 4 }],
      config,
      projectFiles,
    }, new FixedEvaluator(probability));
  }

  it("scores the mixed-branch judgment with the raw evaluator probability and the named branch", async () => {
    const projectFiles: ProjectFile[] = [
      { filePath: "src/users.ts", source: MIXED_OWNER },
      { filePath: "src/show.ts", source: MIXED_CALLER },
    ];

    const judgments = await lint(MIXED_OWNER, projectFiles, 0.2);

    expect(judgments).toHaveLength(1);
    expect(judgments[0]?.probability).toBe(0.2);
    expect(judgments[0]?.evidence).toMatchObject({
      awaitingBranches: [expect.stringContaining("customFinder")],
    });
  });

  it("scores the no-await judgment with the raw evaluator probability and no awaiting branch", async () => {
    const projectFiles: ProjectFile[] = [
      { filePath: "src/users.ts", source: OWNER },
      { filePath: "src/show.ts", source: CALLER },
    ];

    const judgments = await lint(OWNER, projectFiles, 0.2);

    expect(judgments).toHaveLength(1);
    expect(judgments[0]?.probability).toBe(0.2);
    expect(judgments[0]?.evidence).toMatchObject({ awaitingBranches: [] });
  });
});
