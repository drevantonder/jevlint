import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildFsRecursiveReinventEvidence } from "../src/evidence/fs-recursive-reinvent.js";
import type { ProjectFile } from "../src/types.js";

const RULE = "jev/no-fs-recursive-reinvent";

function project(ownerSource: string, excerpt: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/files.ts", source: ownerSource }];
  const candidate = extractCandidates("src/files.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes(excerpt));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no fs candidate.");
  return { candidate, projectFiles };
}

const SMELLY = "import { readdirSync, rmdirSync, unlinkSync, statSync } from \"node:fs\";\n"
  + "import { join } from \"node:path\";\n"
  + "export function removeTree(directory: string): void {\n"
  + "  for (const entry of readdirSync(directory)) {\n"
  + "    const full = join(directory, entry);\n"
  + "    if (statSync(full).isDirectory()) removeTree(full);\n"
  + "    else unlinkSync(full);\n"
  + "  }\n"
  + "  rmdirSync(directory);\n"
  + "}\n";

describe("fs recursive reinvent wiring", () => {
  it("ships as a function judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({ scope: "function", message: expect.any(String) });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("passes recursive walk candidates through dispatch", () => {
    const { candidate, projectFiles } = project(SMELLY, "removeTree");

    const result = buildRuleEvidence(RULE, candidate, projectFiles);

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
  });
});

describe("fs recursive reinvent evidence", () => {
  it("reports a plain recursive remove with no extra semantics", () => {
    const { candidate, projectFiles } = project(SMELLY, "removeTree");

    const evidence = buildFsRecursiveReinventEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "removeTree" },
      operation: "recursive-remove",
      reinventSignals: expect.arrayContaining(["readdir-traversal", "self-recursion", "entry-remove"]),
      filtering: [],
      toleratesEntryErrors: false,
      dryRun: false,
    });
  });

  it("reports an exists-check mkdir chain as recursive make", () => {
    const { candidate, projectFiles } = project(
      "import { existsSync, mkdirSync } from \"node:fs\";\n"
        + "export function ensureDir(directory: string): void {\n"
        + "  if (!existsSync(directory)) mkdirSync(directory);\n"
        + "}\n",
      "ensureDir",
    );

    const evidence = buildFsRecursiveReinventEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      operation: "recursive-make",
      reinventSignals: expect.arrayContaining(["exists-check", "mkdir-chain"]),
    });
  });

  it("abstains where the recursive option is already used", () => {
    const { candidate, projectFiles } = project(
      "import { rmSync } from \"node:fs\";\n"
        + "export function removeTree(directory: string): void {\n"
        + "  rmSync(directory, { recursive: true, force: true });\n"
        + "}\n",
      "removeTree",
    );

    expect(buildFsRecursiveReinventEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when no recursive traversal exists", () => {
    const { candidate, projectFiles } = project(
      "import { readFileSync } from \"node:fs\";\n"
        + "export function readConfig(path: string): string {\n"
        + "  return readFileSync(path, \"utf8\");\n"
        + "}\n",
      "readConfig",
    );

    expect(buildFsRecursiveReinventEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
