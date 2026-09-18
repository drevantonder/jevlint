import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { formatGithub } from "../src/format.js";
import type {
  EvaluationRequest,
  Evaluator,
  Judgment,
} from "../src/types.js";

const execFile = promisify(execFileCallback);

class FixedEvaluator implements Evaluator {
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.73]));
  }
}

class PartialEvaluator implements Evaluator {
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    if (request.state.candidates.some((candidate) => candidate.source.includes("broken"))) {
      throw new Error("400 max_tokens_exceeded");
    }
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.42]));
  }
}

async function repositoryWith(prefix: string, files: Record<string, string>): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  await execFile("git", ["init", "-q"], { cwd });
  await execFile("git", ["config", "user.name", "Test"], { cwd });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd });
  for (const [name, source] of Object.entries(files)) {
    const full = join(cwd, name);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, source);
  }
  await execFile("git", ["add", "."], { cwd });
  await execFile("git", ["commit", "-qm", "initial"], { cwd });
  return cwd;
}

interface CliCapture {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function invoke(args: string[], options: { cwd: string; evaluator: Evaluator }): Promise<CliCapture> {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(args, {
    cwd: options.cwd,
    evaluator: options.evaluator,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { stdout, stderr, exitCode };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function annotationLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.length > 0);
}

describe("github format", () => {
  it("emits one workflow annotation per judgment with span and probability", async () => {
    const cwd = await repositoryWith("jevlint-github-", {
      "a.ts": "export function alpha() { return 0; }\n",
    });
    await writeFile(join(cwd, "a.ts"), "export function alpha() { return 1; }\n");

    const github = await invoke(["review", "--format", "github"], {
      cwd,
      evaluator: new FixedEvaluator(),
    });
    expect(github.exitCode).toBe(0);
    expect(github.stderr).toBe("");
    const lines = annotationLines(github.stdout);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(
        /^::notice file=\S+,line=\d+,col=\d+,endLine=\d+,endColumn=\d+,category=\S+::\d\.\d{3} \S+ .+$/,
      );
    }
    expect(lines[0]).toContain("file=a.ts,");
    expect(lines[0]).toMatch(/::0\.73\d? /);

    const json = await invoke(["review", "--format", "json"], {
      cwd,
      evaluator: new FixedEvaluator(),
    });
    // SAFETY: --format json only prints the report object produced by createReviewReport.
    const report = JSON.parse(json.stdout) as { judgments: Array<{ probability: number }> };
    expect(lines.length).toBe(report.judgments.length);
  });

  it("supports the -f alias for --format", async () => {
    const cwd = await repositoryWith("jevlint-github-alias-", {
      "a.ts": "export function alpha() { return 0; }\n",
    });
    await writeFile(join(cwd, "a.ts"), "export function alpha() { return 1; }\n");

    const capture = await invoke(["review", "-f", "github"], {
      cwd,
      evaluator: new FixedEvaluator(),
    });
    expect(capture.exitCode).toBe(0);
    const lines = annotationLines(capture.stdout);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.startsWith("::notice ")).toBe(true);
    }
  });

  it("keeps completed annotations and exits 2 on evaluation failures", async () => {
    const cwd = await repositoryWith("jevlint-github-partial-", {
      "a.ts": "export function first() { return 0; }\nexport function broken() { return 0; }\n",
    });
    await writeFile(
      join(cwd, "a.ts"),
      "export function first() { return 1; }\nexport function broken() { return 1; }\n",
    );

    const capture = await invoke(["review", "--format", "github"], {
      cwd,
      evaluator: new PartialEvaluator(),
    });
    expect(capture.exitCode).toBe(2);
    const lines = annotationLines(capture.stdout);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.startsWith("::notice ")).toBe(true);
    }
    expect(capture.stderr).toContain("evaluation question");
  });

  it("emits every judgment regardless of display filters", async () => {
    const cwd = await repositoryWith("jevlint-github-filters-", {
      "a.ts": "export function alpha() { return 0; }\n",
    });
    await writeFile(join(cwd, "a.ts"), "export function alpha() { return 1; }\n");

    const filtered = await invoke(
      ["review", "--format", "github", "--min-score", "0.99", "--limit", "1"],
      { cwd, evaluator: new FixedEvaluator() },
    );
    const unfiltered = await invoke(["review", "--format", "github"], {
      cwd,
      evaluator: new FixedEvaluator(),
    });
    expect(filtered.exitCode).toBe(0);
    expect(annotationLines(filtered.stdout)).toEqual(annotationLines(unfiltered.stdout));
    expect(annotationLines(filtered.stdout).length).toBeGreaterThan(1);
  });

  it("rejects unknown formats without evaluating", async () => {
    const cwd = await repositoryWith("jevlint-github-bad-", {
      "a.ts": "export function alpha() { return 0; }\n",
    });
    let calls = 0;
    const evaluator: Evaluator = {
      evaluate: (request: EvaluationRequest): Promise<Record<string, number>> => {
        calls += 1;
        return Promise.resolve(
          Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.1])),
        );
      },
    };
    const capture = await invoke(["review", "--format", "bogus"], { cwd, evaluator });
    expect(capture.exitCode).toBe(2);
    expect(capture.stderr).toContain("Usage: jevlint");
    expect(calls).toBe(0);
  });

  it("escapes annotation data and properties", () => {
    const judgment: Judgment = {
      ruleId: "test/rule",
      message: "100% certain,\nwith: details\rhere",
      probability: 0.5,
      category: "security",
      filePath: "src/a.ts",
      span: {
        start: { line: 3, column: 2 },
        end: { line: 4, column: 9 },
      },
      candidateKind: "function",
      evidence: null,
    };
    const output = formatGithub({
      version: 1,
      summary: { evaluated: 1, displayed: 1, abstained: 0, failed: 0, complete: true },
      judgments: [judgment],
      display: { minScore: 0, limit: 5 },
      abstentions: [],
      failures: { total: 0, omitted: 0, items: [] },
      statistics: { evaluation: { requests: 1, questions: 1 } },
    });
    expect(output).toBe(
      "::notice file=src/a.ts,line=3,col=2,endLine=4,endColumn=9,category=security"
      + "::0.500 test/rule 100%25 certain,%0Awith: details%0Dhere",
    );
  });

  it("renders no lines for an empty report", () => {
    const output = formatGithub({
      version: 1,
      summary: { evaluated: 0, displayed: 0, abstained: 0, failed: 0, complete: true },
      judgments: [],
      display: { minScore: 0, limit: 5 },
      abstentions: [],
      failures: { total: 0, omitted: 0, items: [] },
      statistics: { evaluation: { requests: 0, questions: 0 } },
    });
    expect(output).toBe("");
  });
});

describe("out-dir artifacts", () => {
  it("writes one artifact per reviewed file plus summary.json without replacing stdout", async () => {
    const cwd = await repositoryWith("jevlint-outdir-review-", {
      "a.ts": "export function alpha() { return 0; }\n",
      "sub/b.ts": "export function beta() { return 0; }\n",
    });
    await writeFile(join(cwd, "a.ts"), "export function alpha() { return 1; }\n");
    await writeFile(join(cwd, "sub/b.ts"), "export function beta() { return 1; }\n");
    const outDir = join(cwd, "out");

    const text = await invoke(["review", "--out-dir", outDir], {
      cwd,
      evaluator: new FixedEvaluator(),
    });
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("evaluated;");

    // SAFETY: --out-dir writes one JSON file per evaluated file plus a summary.
    const artifactA = JSON.parse(await readFile(join(outDir, "a.ts.json"), "utf8")) as {
      version: number;
      filePath: string;
      summary: { evaluated: number; abstained: number };
      judgments: Array<{ filePath: string }>;
      abstentions: Array<{ ruleId: string; count: number }>;
    };
    expect(artifactA.version).toBe(1);
    expect(artifactA.filePath).toBe("a.ts");
    for (const judgment of artifactA.judgments) {
      expect(judgment.filePath).toBe("a.ts");
    }
    expect(artifactA.summary.evaluated).toBe(artifactA.judgments.length);
    expect(Array.isArray(artifactA.abstentions)).toBe(true);

    // SAFETY: --out-dir writes one JSON file per evaluated file plus a summary.
    const artifactB = JSON.parse(await readFile(join(outDir, "sub", "b.ts.json"), "utf8")) as {
      filePath: string;
      judgments: Array<{ filePath: string }>;
    };
    expect(artifactB.filePath).toBe("sub/b.ts");
    for (const judgment of artifactB.judgments) {
      expect(judgment.filePath).toBe("sub/b.ts");
    }

    const json = await invoke(["review", "--format", "json", "--out-dir", join(cwd, "out-json")], {
      cwd,
      evaluator: new FixedEvaluator(),
    });
    expect(json.exitCode).toBe(0);
    // SAFETY: --format json only prints the report object produced by createReviewReport.
    const stdoutReport = JSON.parse(json.stdout) as unknown;
    // SAFETY: --out-dir writes summary.json with the full report.
    const summaryReport = JSON.parse(
      await readFile(join(cwd, "out-json", "summary.json"), "utf8"),
    ) as unknown;
    expect(summaryReport).toEqual(stdoutReport);
  });

  it("writes review file artifacts incrementally as files complete", async () => {
    const cwd = await repositoryWith("jevlint-outdir-incr-", {
      "a.ts": "export function alpha() { return 0; }\n",
      "b.ts": "export function beta() { return 0; }\n",
    });
    await writeFile(join(cwd, "a.ts"), "export function alpha() { return 1; }\n");
    await writeFile(join(cwd, "b.ts"), "export function beta() { return 1; }\n");
    const outDir = join(cwd, "out");
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const evaluator: Evaluator = {
      evaluate: (request: EvaluationRequest): Promise<Record<string, number>> => {
        const answers = Object.fromEntries(
          Object.keys(request.questions).map((id) => [id, 0.5]),
        );
        if (request.state.file.path.endsWith("b.ts")) {
          return gate.then(() => answers);
        }
        return Promise.resolve(answers);
      },
    };

    const runPromise = invoke(["review", "--out-dir", outDir], { cwd, evaluator });
    const deadline = Date.now() + 10000;
    let artifact: string | undefined;
    while (Date.now() < deadline) {
      try {
        artifact = await readFile(join(outDir, "a.ts.json"), "utf8");
        break;
      } catch {
        await sleep(50);
      }
    }
    expect(artifact).toBeDefined();
    // SAFETY: the poll loop only exits early with the a.ts artifact contents.
    const parsed = JSON.parse(artifact as string) as { filePath: string };
    expect(parsed.filePath).toBe("a.ts");
    releaseGate();
    const capture = await runPromise;
    expect(capture.exitCode).toBe(0);
    // SAFETY: --out-dir writes one JSON file per evaluated file plus a summary.
    const summary = JSON.parse(
      await readFile(join(outDir, "summary.json"), "utf8"),
    ) as { judgments: unknown[] };
    expect(summary.judgments.length).toBeGreaterThan(0);
  });

  it("scopes review artifacts to positional paths and staged changes", async () => {
    const cwd = await repositoryWith("jevlint-outdir-scope-", {
      "a.ts": "export function alpha() { return 0; }\n",
      "sub/b.ts": "export function beta() { return 0; }\n",
    });
    await writeFile(join(cwd, "a.ts"), "export function alpha() { return 1; }\n");
    await writeFile(join(cwd, "sub/b.ts"), "export function beta() { return 1; }\n");

    const scoped = await invoke(["review", "sub", "--out-dir", join(cwd, "out-sub")], {
      cwd,
      evaluator: new FixedEvaluator(),
    });
    expect(scoped.exitCode).toBe(0);
    // SAFETY: --out-dir writes one JSON file per evaluated file plus a summary.
    const scopedArtifact = JSON.parse(
      await readFile(join(cwd, "out-sub", "sub", "b.ts.json"), "utf8"),
    ) as { filePath: string };
    expect(scopedArtifact.filePath).toBe("sub/b.ts");
    await expect(readFile(join(cwd, "out-sub", "a.ts.json"), "utf8")).rejects.toThrow();

    await execFile("git", ["add", "a.ts"], { cwd });
    await writeFile(join(cwd, "a.ts"), "export function alpha() { return 2; }\n");
    const staged = await invoke(
      ["review", "--staged", "--out-dir", join(cwd, "out-staged")],
      { cwd, evaluator: new FixedEvaluator() },
    );
    expect(staged.exitCode).toBe(0);
    // SAFETY: --out-dir writes one JSON file per evaluated file plus a summary.
    const stagedArtifact = JSON.parse(
      await readFile(join(cwd, "out-staged", "a.ts.json"), "utf8"),
    ) as { filePath: string };
    expect(stagedArtifact.filePath).toBe("a.ts");
  });

  it("writes audit artifacts per file with coverage in summary.json", async () => {
    const cwd = await repositoryWith("jevlint-outdir-audit-", {
      "a.ts": "export function alpha() { return 0; }\n",
      "sub/b.ts": "export function beta() { return 0; }\n",
    });
    const outDir = join(cwd, "out");

    const capture = await invoke(["audit", "sub", "--format", "json", "--out-dir", outDir], {
      cwd,
      evaluator: new FixedEvaluator(),
    });
    expect(capture.exitCode).toBe(0);
    // SAFETY: --out-dir writes one JSON file per evaluated file plus a summary.
    const artifact = JSON.parse(
      await readFile(join(outDir, "sub", "b.ts.json"), "utf8"),
    ) as { filePath: string; judgments: Array<{ filePath: string }> };
    expect(artifact.filePath).toBe("sub/b.ts");
    for (const judgment of artifact.judgments) {
      expect(judgment.filePath).toBe("sub/b.ts");
    }
    // SAFETY: --out-dir writes summary.json with the full report.
    const summary = JSON.parse(
      await readFile(join(outDir, "summary.json"), "utf8"),
    ) as {
      judgments: unknown[];
      coverage: { filesEnumerated: number; complete: boolean };
    };
    expect(summary.coverage.filesEnumerated).toBe(1);
    // SAFETY: --format json only prints the report object produced by createReviewReport.
    expect(summary).toEqual(JSON.parse(capture.stdout) as unknown);
  });

  it("writes only summary.json for an audit dry run", async () => {
    const cwd = await repositoryWith("jevlint-outdir-dry-", {
      "a.ts": "export function alpha() { return 0; }\n",
    });
    const outDir = join(cwd, "out");

    const capture = await invoke(
      ["audit", "--dry-run", "--format", "json", "--out-dir", outDir],
      { cwd, evaluator: new FixedEvaluator() },
    );
    expect(capture.exitCode).toBe(0);
    // SAFETY: --out-dir writes summary.json with the full report.
    const summary = JSON.parse(
      await readFile(join(outDir, "summary.json"), "utf8"),
    ) as { coverage: { dryRun: boolean } };
    expect(summary.coverage.dryRun).toBe(true);
    expect(await readdir(outDir)).toEqual(["summary.json"]);
  });

  it("composes out-dir with the github format", async () => {
    const cwd = await repositoryWith("jevlint-outdir-github-", {
      "a.ts": "export function alpha() { return 0; }\n",
    });
    await writeFile(join(cwd, "a.ts"), "export function alpha() { return 1; }\n");
    const outDir = join(cwd, "out");

    const capture = await invoke(["review", "--format", "github", "--out-dir", outDir], {
      cwd,
      evaluator: new FixedEvaluator(),
    });
    expect(capture.exitCode).toBe(0);
    for (const line of annotationLines(capture.stdout)) {
      expect(line.startsWith("::notice ")).toBe(true);
    }
    // SAFETY: --out-dir writes one JSON file per evaluated file plus a summary.
    const artifact = JSON.parse(
      await readFile(join(outDir, "a.ts.json"), "utf8"),
    ) as { filePath: string };
    expect(artifact.filePath).toBe("a.ts");
  });
});
