import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { analyzeFile } from "../src/analyze.js";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildAmbientDependencyGrabEvidence } from "../src/evidence/ambient-dependency-grab.js";
import { buildConstructionInUseEvidence } from "../src/evidence/construction-in-use.js";
import { buildUntestableSingletonGrabEvidence } from "../src/evidence/untestable-singleton-grab.js";
import type {
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

const DI_RULES: string[] = [
  "jev/no-construction-in-use",
  "jev/no-untestable-singleton-grab",
  "jev/no-ambient-dependency-grab",
] as const;

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function functionCandidate(owner: ProjectFile, snippet: string) {
  return extractCandidates(owner.filePath, owner.source)
    .filter(({ kind, source }) => kind === "function" && source.includes(snippet))
    .sort((left, right) => left.source.length - right.source.length)[0];
}

type EvidenceProbe = {
  instructions?: {
    evidence?: string | null;
  };
};

type DiEvidenceProbe = {
  constructions?: unknown[];
  accesses?: unknown[];
  grabs?: unknown[];
};

/** Fake evaluator: scores from structural evidence alone, no live Jev calls.
 * Evidence travels under request.state.candidates[i].evidence[ruleId]; the
 * raw score for each question comes from its own candidate's evidence.
 * Scores flow straight into judgments; nothing is cut off. */
class DiScoringEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    return Object.fromEntries(
      Object.entries(request.questions).map(([id, question]) => {
        // SAFETY: jevlint builds every evaluation question with its own
        // QuestionInstructions record carrying the evidence path, so viewing
        // instructions through the probe type is sound within this suite.
        const instructions = (question as EvidenceProbe).instructions;
        const match = /candidates\[(\d+)\]/.exec(instructions?.evidence ?? "");
        const candidate = match ? request.state.candidates[Number(match[1])] : undefined;
        // SAFETY: the DI builders emit constructions, accesses, and grabs as
        // arrays when present, and the length checks below admit only
        // genuine non-empty arrays.
        const evidence = (candidate?.evidence ?? {}) as Record<string, DiEvidenceProbe>;
        const fires = Object.values(evidence).some((rule) =>
          (Array.isArray(rule.constructions) && rule.constructions.length > 0)
          || (Array.isArray(rule.accesses) && rule.accesses.length > 0)
          || (Array.isArray(rule.grabs) && rule.grabs.length > 0)
        );
        return [id, fires ? 0.77 : 0.18];
      }),
    );
  }
}

function diConfig(): JevLintConfig {
  const rules: JevLintConfig["rules"] = {};
  for (const ruleId of DI_RULES) {
    const rule = defaultConfig.rules[ruleId];
    expect(rule).toBeDefined();
    if (!rule) continue;
    rules[ruleId] = rule;
  }
  return { rules };
}

function changedLines(source: string) {
  return [{ start: 1, end: source.split("\n").length }];
}

describe("composition root exemption", () => {
  it("abstains structurally for a seam-taking entry invoked with raw process inputs", async () => {
    const projectFiles = await project("composition-root-entry", [
      "src/cli.ts",
      "src/store.ts",
      "src/db.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = functionCandidate(owner, "new PostgresStore");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildConstructionInUseEvidence(candidate, projectFiles)).toBeUndefined();
    expect(buildAmbientDependencyGrabEvidence(candidate, projectFiles)).toBeUndefined();
    expect(buildUntestableSingletonGrabEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("still fires for mid-tree construction reached with domain values", async () => {
    const projectFiles = await project("composition-root-midtree", [
      "src/orders.ts",
      "src/checkout.ts",
      "src/store.ts",
      "src/db.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = functionCandidate(owner, "new PostgresStore");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildConstructionInUseEvidence(candidate, projectFiles)).toMatchObject({
      constructions: [expect.objectContaining({
        kind: "new",
        classOrFactory: "PostgresStore",
        behaviorUse: "method-call",
      })],
    });
    expect(buildAmbientDependencyGrabEvidence(candidate, projectFiles)).toMatchObject({
      accesses: [expect.objectContaining({ kind: "singleton", root: "Db" })],
    });
    expect(buildUntestableSingletonGrabEvidence(candidate, projectFiles)).toMatchObject({
      grabs: expect.arrayContaining([
        expect.objectContaining({ local: "getDatabase" }),
        expect.objectContaining({ local: "Db" }),
      ]),
      injectedViaParam: false,
    });
  });

  it("still fires for an entry-shaped function whose caller passes domain values", () => {
    const cliSource = `import { PostgresStore } from "./store.js";

export function runCli(args: string[], cwd: string): void {
  const store = new PostgresStore(cwd);
  store.save(args.length);
}
`;
    const bootSource = `import { runCli } from "./cli.js";

export function boot(): void {
  runCli(["--json"], "/tmp");
}
`;
    const projectFiles: ProjectFile[] = [
      { filePath: "src/cli.ts", source: cliSource },
      { filePath: "src/boot.ts", source: bootSource },
    ];
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = functionCandidate(owner, "new PostgresStore");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildConstructionInUseEvidence(candidate, projectFiles)).toMatchObject({
      constructions: [expect.objectContaining({ classOrFactory: "PostgresStore" })],
    });
  });

  it("still fires for an entry without injectable seams", () => {
    const cliSource = `import { PostgresStore } from "./store.js";

export function main(): void {
  const store = new PostgresStore("postgres://localhost:5432/shop");
  store.save(1);
}

main();
`;
    const projectFiles: ProjectFile[] = [{ filePath: "src/cli.ts", source: cliSource }];
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;
    const candidate = functionCandidate(owner, "new PostgresStore");
    expect(candidate).toBeDefined();
    if (!candidate) return;

    expect(buildConstructionInUseEvidence(candidate, projectFiles)).toMatchObject({
      constructions: [expect.objectContaining({ classOrFactory: "PostgresStore" })],
    });
  });
});

describe("composition root judgments via fake evaluator", () => {
  it("carries raw fake scores into judgments with no cutoff", async () => {
    const [entry, midtree] = await Promise.all([
      project("composition-root-entry", ["src/cli.ts", "src/store.ts", "src/db.ts"]),
      project("composition-root-midtree", [
        "src/orders.ts",
        "src/checkout.ts",
        "src/store.ts",
        "src/db.ts",
      ]),
    ]);
    const entryOwner = entry[0];
    const midtreeOwner = midtree[0];
    expect(entryOwner).toBeDefined();
    expect(midtreeOwner).toBeDefined();
    if (!entryOwner || !midtreeOwner) return;
    const config = diConfig();
    const evaluator = new DiScoringEvaluator();

    const abstained = await analyzeFile(
      {
        filePath: entryOwner.filePath,
        source: entryOwner.source,
        changedLines: changedLines(entryOwner.source),
        config,
        projectFiles: entry,
      },
      evaluator,
    );
    expect(abstained.filter(({ ruleId }) => DI_RULES.includes(ruleId))).toHaveLength(0);

    const hot = await analyzeFile(
      {
        filePath: midtreeOwner.filePath,
        source: midtreeOwner.source,
        changedLines: changedLines(midtreeOwner.source),
        config,
        projectFiles: midtree,
      },
      evaluator,
    );
    // Raw fake scores flow straight into judgments; nothing is cut off.
    for (const ruleId of DI_RULES) {
      expect(hot).toContainEqual(
        expect.objectContaining({ ruleId, probability: 0.77 }),
      );
    }
  });
});
