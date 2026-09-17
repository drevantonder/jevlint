import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import type { EvaluationRequest, Evaluator } from "../src/types.js";

const execFile = promisify(execFileCallback);

class PassThroughEvaluator implements Evaluator {
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [
      id,
      JSON.stringify(question).includes("jev/no-pass-through-wrapper") ? 0.99 : 0.1,
    ]));
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

class CountingEvaluator implements Evaluator {
  calls = 0;

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.calls += 1;
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.1]));
  }
}

async function repository(prefix: string, source: string): Promise<{ cwd: string; path: string }> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  await execFile("git", ["init", "-q"], { cwd });
  await execFile("git", ["config", "user.name", "Test"], { cwd });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd });
  const path = join(cwd, "changed.ts");
  await writeFile(path, source);
  await execFile("git", ["add", "."], { cwd });
  await execFile("git", ["commit", "-qm", "initial"], { cwd });
  return { cwd, path };
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

describe("runCli", () => {
  it("reviews changed candidates without failing on high scores", async () => {
    const { cwd, path } = await repository(
      "jevlint-cli-",
      "export function wrap(value: string) {\n  return target(value);\n}\n",
    );
    await writeFile(path, "export function wrap(value: string) {\n  return target(value.trim());\n}\n");

    let stdout = "";
    let stderr = "";
    const exitCode = await runCli(["review"], {
      cwd,
      evaluator: new PassThroughEvaluator(),
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("0.990  changed.ts:1:8");
    expect(stdout).toContain("function  jev/no-pass-through-wrapper");
    expect(stdout).toMatch(/\d+ evaluated; \d+ displayed;/);
  });

  it("writes partial JSON judgments and bounded evaluation failures", async () => {
    const { cwd, path } = await repository(
      "jevlint-cli-partial-",
      "export function first() { return 0; }\nexport function broken() { return 0; }\n",
    );
    await writeFile(
      path,
      "export function first() { return 1; }\nexport function broken() { return 1; }\n",
    );

    let stdout = "";
    let stderr = "";
    const exitCode = await runCli(["review", "--format", "json"], {
      cwd,
      evaluator: new PartialEvaluator(),
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    // SAFETY: runCli only prints the report object produced by createReviewReport.
    const report = JSON.parse(stdout) as {
      version: number;
      summary: { evaluated: number; failed: number; complete: boolean };
      judgments: unknown[];
      failures: { total: number; omitted: number; items: unknown[] };
    };
    expect(exitCode).toBe(2);
    expect(report.version).toBe(1);
    expect(report.summary.evaluated).toBeGreaterThan(0);
    expect(report.summary.failed).toBeGreaterThan(0);
    expect(report.summary.complete).toBe(false);
    expect(report.judgments.length).toBeGreaterThan(0);
    expect(report.failures.total).toBeGreaterThan(0);
    expect(report.failures.items.length).toBeLessThanOrEqual(20);
    expect(stderr).toContain("evaluation question");
    expect(stderr).toContain("max_tokens_exceeded");
  });

  it("filters text display while JSON keeps every evaluated judgment", async () => {
    const { cwd, path } = await repository(
      "jevlint-cli-filter-",
      "export function wrap(value: string) { return target(value); }\n",
    );
    await writeFile(path, "export function wrap(value: string) { return target(value.trim()); }\n");

    let stdout = "";
    const exitCode = await runCli(
      ["review", "--format", "json", "--min-score", "0.5", "--limit", "1"],
      {
        cwd,
        evaluator: new PassThroughEvaluator(),
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => undefined,
      },
    );

    // SAFETY: runCli only prints the report object produced by createReviewReport.
    const report = JSON.parse(stdout) as {
      summary: { evaluated: number; displayed: number };
      judgments: Array<{ probability: number }>;
    };
    expect(exitCode).toBe(0);
    expect(report.summary.evaluated).toBeGreaterThan(report.summary.displayed);
    expect(report.summary.displayed).toBe(1);
    expect(report.judgments).toHaveLength(report.summary.evaluated);
    expect(report.judgments).toContainEqual(expect.objectContaining({ probability: 0.99 }));

    let textStdout = "";
    const textExitCode = await runCli(
      ["review", "--min-score", "0.5", "--limit", "1"],
      {
        cwd,
        evaluator: new PassThroughEvaluator(),
        stdout: (text) => {
          textStdout += text;
        },
        stderr: () => undefined,
      },
    );
    expect(textExitCode).toBe(0);
    const scoreLines = textStdout.trim().split("\n")
      .filter((line) => /^\d\.\d{3}  /.test(line));
    expect(scoreLines).toHaveLength(1);
    expect(scoreLines[0]).toContain("0.990  changed.ts:1:8");
    expect(textStdout).toMatch(/\d+ evaluated; 1 displayed; /);
  });

  it("rejects the removed diff alias without calling the evaluator", async () => {
    const evaluator = new CountingEvaluator();
    const capture = await invoke(["diff"], { cwd: process.cwd(), evaluator });

    expect(capture.exitCode).toBe(2);
    expect(capture.stderr).toContain("Usage: jevlint review");
    expect(evaluator.calls).toBe(0);
  });

  it("rejects the removed verbose flag", async () => {
    const evaluator = new CountingEvaluator();
    const capture = await invoke(["review", "--verbose"], {
      cwd: process.cwd(),
      evaluator,
    });

    expect(capture.exitCode).toBe(2);
    expect(capture.stderr).toContain("Usage: jevlint review");
    expect(evaluator.calls).toBe(0);
  });

  it("reports cache status with debug cache and stays silent without it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevlint-cli-cache-"));
    await execFile("git", ["init", "-q"], { cwd });

    const debug = await invoke(["review", "--no-cache", "--debug=cache"], {
      cwd,
      evaluator: new PassThroughEvaluator(),
    });
    expect(debug.exitCode).toBe(0);
    expect(debug.stderr).toBe("jevlint cache: disabled\n");

    const silent = await invoke(["review", "--no-cache"], {
      cwd,
      evaluator: new PassThroughEvaluator(),
    });
    expect(silent.exitCode).toBe(0);
    expect(silent.stderr).toBe("");
  });

  it("rejects conflicting cache modes", async () => {
    let stderr = "";
    const exitCode = await runCli(["review", "--no-cache", "--refresh-cache"], {
      cwd: process.cwd(),
      evaluator: new PassThroughEvaluator(),
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(2);
    expect(stderr).toContain("Usage: jevlint review");
  });

  it("rejects unsupported commands without calling the evaluator", async () => {
    let stderr = "";
    const exitCode = await runCli(["wat"], {
      cwd: process.cwd(),
      evaluator: new PassThroughEvaluator(),
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(2);
    expect(stderr).toContain("Usage: jevlint");
  });

  it("rejects command-scoped flags on the wrong command", async () => {
    for (const args of [
      ["audit", "--staged"],
      ["review", "--dry-run"],
      ["review", "--max-questions", "10"],
      ["review", "--evidence-budget-ms", "100"],
    ]) {
      const evaluator = new CountingEvaluator();
      const capture = await invoke(args, { cwd: process.cwd(), evaluator });
      expect(capture.exitCode).toBe(2);
      expect(capture.stderr).toContain("Usage: jevlint");
      expect(evaluator.calls).toBe(0);
    }
  });

  it("filters review scope to positional files and directories", async () => {
    const cwd = await repositoryWith("jevlint-cli-scope-", {
      "a.ts": "export function alpha() { return 0; }\n",
      "sub/b.ts": "export function beta() { return 0; }\n",
    });
    await writeFile(join(cwd, "a.ts"), "export function alpha() { return 1; }\n");
    await writeFile(join(cwd, "sub/b.ts"), "export function beta() { return 1; }\n");

    const capture = await invoke(["review", "sub", "--format", "json"], {
      cwd,
      evaluator: new CountingEvaluator(),
    });
    expect(capture.exitCode).toBe(0);
    // SAFETY: runCli only prints the report object produced by createReviewReport.
    const report = JSON.parse(capture.stdout) as {
      summary: { evaluated: number };
      judgments: Array<{ filePath: string }>;
    };
    expect(report.summary.evaluated).toBeGreaterThan(0);
    expect(report.judgments.length).toBeGreaterThan(0);
    for (const judgment of report.judgments) {
      expect(judgment.filePath).toBe("sub/b.ts");
    }
  });

  it("defaults audit to the full tree while review stays on changed files", async () => {
    const cwd = await repositoryWith("jevlint-cli-audit-", {
      "tracked.ts": "export function tracked() { return 0; }\n",
      "other.ts": "export function other() { return 0; }\n",
    });
    await writeFile(join(cwd, "tracked.ts"), "export function tracked() { return 1; }\n");
    const evaluator = new CountingEvaluator();

    const audit = await invoke(["audit", "--debug=files"], { cwd, evaluator });
    expect(audit.exitCode).toBe(0);
    expect(audit.stdout).toBe("");
    expect(audit.stderr).toBe("other.ts\ntracked.ts\n");

    const review = await invoke(["review", "--debug=files"], { cwd, evaluator });
    expect(review.exitCode).toBe(0);
    expect(review.stdout).toBe("");
    expect(review.stderr).toBe("tracked.ts\n");

    const narrowed = await invoke(["audit", "--debug=files", "other.ts"], { cwd, evaluator });
    expect(narrowed.exitCode).toBe(0);
    expect(narrowed.stderr).toBe("other.ts\n");
    expect(evaluator.calls).toBe(0);
  });

  it("audits unchanged files that review skips", async () => {
    const cwd = await repositoryWith("jevlint-cli-audit-run-", {
      "tracked.ts": "export function tracked() { return 0; }\n",
      "other.ts": "export function other() { return 0; }\n",
    });
    await writeFile(join(cwd, "tracked.ts"), "export function tracked() { return 1; }\n");

    const audit = await invoke(["audit", "--format", "json"], {
      cwd,
      evaluator: new CountingEvaluator(),
    });
    expect(audit.exitCode).toBe(0);
    // SAFETY: runCli only prints the report object produced by createReviewReport.
    const auditReport = JSON.parse(audit.stdout) as {
      judgments: Array<{ filePath: string }>;
      coverage: { filesEnumerated: number; complete: boolean };
    };
    const audited = new Set(auditReport.judgments.map((judgment) => judgment.filePath));
    expect(audited).toContain("tracked.ts");
    expect(audited).toContain("other.ts");
    expect(auditReport.coverage.filesEnumerated).toBe(2);
    expect(auditReport.coverage.complete).toBe(true);

    const review = await invoke(["review", "--format", "json"], {
      cwd,
      evaluator: new CountingEvaluator(),
    });
    expect(review.exitCode).toBe(0);
    // SAFETY: runCli only prints the report object produced by createReviewReport.
    const reviewReport = JSON.parse(review.stdout) as {
      judgments: Array<{ filePath: string }>;
    };
    const reviewed = new Set(reviewReport.judgments.map((judgment) => judgment.filePath));
    expect(reviewed).toContain("tracked.ts");
    expect(reviewed).not.toContain("other.ts");
  });

  it("scopes audit coverage to positional paths", async () => {
    const cwd = await repositoryWith("jevlint-cli-audit-scope-", {
      "tracked.ts": "export function tracked() { return 0; }\n",
      "sub/other.ts": "export function other() { return 0; }\n",
    });

    const capture = await invoke(["audit", "sub", "--format", "json"], {
      cwd,
      evaluator: new CountingEvaluator(),
    });
    expect(capture.exitCode).toBe(0);
    // SAFETY: runCli only prints the report object produced by createReviewReport.
    const report = JSON.parse(capture.stdout) as {
      judgments: Array<{ filePath: string }>;
      coverage: { filesEnumerated: number };
    };
    expect(report.coverage.filesEnumerated).toBe(1);
    for (const judgment of report.judgments) {
      expect(judgment.filePath).toBe("sub/other.ts");
    }
  });

  it("counts audit cost without evaluating on dry run with a question cap", async () => {
    const cwd = await repositoryWith("jevlint-cli-audit-dry-", {
      "tracked.ts": "export function tracked() { return 0; }\n",
      "other.ts": "export function other() { return 0; }\n",
    });
    const evaluator = new CountingEvaluator();

    const capture = await invoke(["audit", "--max-questions", "1", "--dry-run", "--format", "json"], {
      cwd,
      evaluator,
    });
    expect(capture.exitCode).toBe(0);
    expect(evaluator.calls).toBe(0);
    // SAFETY: runCli only prints the report object produced by createReviewReport.
    const report = JSON.parse(capture.stdout) as {
      judgments: unknown[];
      coverage: {
        questionsPrepared: number;
        maxQuestions: number;
        dryRun: boolean;
        complete: boolean;
      };
    };
    expect(report.coverage.dryRun).toBe(true);
    expect(report.coverage.maxQuestions).toBe(1);
    expect(report.coverage.questionsPrepared).toBe(1);
    expect(report.coverage.complete).toBe(false);
    expect(report.judgments).toEqual([]);
  });

  it("errors on unmatched paths unless no-error-on-unmatched-pattern is given", async () => {
    const cwd = await repositoryWith("jevlint-cli-unmatched-", {
      "tracked.ts": "export function tracked() { return 0; }\n",
      "other.ts": "export function other() { return 0; }\n",
    });
    await writeFile(join(cwd, "tracked.ts"), "export function tracked() { return 1; }\n");

    for (const command of ["review", "audit"]) {
      const missing = await invoke([command, "nope.ts"], {
        cwd,
        evaluator: new CountingEvaluator(),
      });
      expect(missing.exitCode).toBe(2);
      expect(missing.stderr).toContain("no files matched");

      const outOfScope = await invoke([command, "other.ts"], {
        cwd,
        evaluator: new CountingEvaluator(),
      });
      // SAFETY: review scopes to changed files, so an unchanged path is unmatched; audit covers the full tree.
      expect(outOfScope.exitCode).toBe(command === "review" ? 2 : 0);

      const empty = await invoke([command, "nope.ts", "--no-error-on-unmatched-pattern", "--format", "json"], {
        cwd,
        evaluator: new CountingEvaluator(),
      });
      expect(empty.exitCode).toBe(0);
      // SAFETY: runCli only prints the report object produced by createReviewReport.
      const report = JSON.parse(empty.stdout) as {
        summary: { evaluated: number; displayed: number };
        judgments: unknown[];
      };
      expect(report.summary.evaluated).toBe(0);
      expect(report.summary.displayed).toBe(0);
      expect(report.judgments).toEqual([]);
    }
  });

  it("prints post-filter staged scope with debug files and exits without evaluating", async () => {
    const cwd = await repositoryWith("jevlint-cli-staged-", {
      "a.ts": "export function alpha() { return 0; }\n",
    });
    await writeFile(join(cwd, "a.ts"), "export function alpha() { return 1; }\n");
    await execFile("git", ["add", "a.ts"], { cwd });
    const evaluator = new CountingEvaluator();

    const capture = await invoke(["review", "--staged", "--debug=files", "a.ts"], {
      cwd,
      evaluator,
    });

    expect(capture.exitCode).toBe(0);
    expect(capture.stdout).toBe("");
    expect(capture.stderr).toBe("a.ts\n");
    expect(evaluator.calls).toBe(0);
  });

  it("prints a per-rule timing table while stdout stays machine-clean", async () => {
    const { cwd, path } = await repository(
      "jevlint-cli-timings-",
      "export function wrap(value: string) { return target(value); }\n",
    );
    await writeFile(path, "export function wrap(value: string) { return target(value.trim()); }\n");

    const capture = await invoke(["review", "--format", "json", "--debug=timings"], {
      cwd,
      evaluator: new CountingEvaluator(),
    });

    expect(capture.exitCode).toBe(0);
    // SAFETY: runCli only prints the report object produced by createReviewReport.
    const report = JSON.parse(capture.stdout) as {
      version: number;
      summary: { evaluated: number };
    };
    expect(report.version).toBe(1);
    expect(report.summary.evaluated).toBeGreaterThan(0);
    expect(capture.stderr).toContain("jevlint timings:\n");
    expect(capture.stderr).toMatch(/jev\/\S+  \d+ questions?  \d+ ms/);
  });

  it("times audit runs per rule without disturbing stdout", async () => {
    const cwd = await repositoryWith("jevlint-cli-audit-timings-", {
      "a.ts": "export function alpha() { return 0; }\n",
    });

    const capture = await invoke(["audit", "--format", "json", "--debug=timings"], {
      cwd,
      evaluator: new CountingEvaluator(),
    });

    expect(capture.exitCode).toBe(0);
    // SAFETY: runCli only prints the report object produced by createReviewReport.
    const report = JSON.parse(capture.stdout) as {
      version: number;
      coverage: { complete: boolean };
    };
    expect(report.version).toBe(1);
    expect(report.coverage.complete).toBe(true);
    expect(capture.stderr).toContain("jevlint timings:\n");
    expect(capture.stderr).toMatch(/jev\/\S+  \d+ questions?  \d+ ms/);
  });

  it("dumps effective config with print-config and exits without evaluating", async () => {
    const cwd = await repositoryWith("jevlint-cli-config-", {
      "a.ts": "export function alpha() { return 0; }\n",
    });
    const evaluator = new CountingEvaluator();

    const capture = await invoke(["review", "--print-config"], { cwd, evaluator });
    expect(capture.exitCode).toBe(0);
    // SAFETY: --print-config only prints the loaded JevLintConfig.
    const config = JSON.parse(capture.stdout) as { rules: Record<string, { scope: string }> };
    expect(Object.keys(config.rules).length).toBeGreaterThan(0);
    expect(config.rules["jev/no-pass-through-wrapper"]).toBeDefined();
    expect(evaluator.calls).toBe(0);

    const auditCapture = await invoke(["audit", "--print-config"], { cwd, evaluator });
    expect(auditCapture.exitCode).toBe(0);
    // SAFETY: --print-config only prints the loaded JevLintConfig.
    const auditConfig = JSON.parse(auditCapture.stdout) as { rules: Record<string, { scope: string }> };
    expect(auditConfig).toEqual(config);
    expect(evaluator.calls).toBe(0);

    const overridePath = join(cwd, "jevlint.test.mjs");
    await writeFile(
      overridePath,
      `export default { rules: { "jev/no-pass-through-wrapper": "off" } };\n`,
    );
    const overridden = await invoke(["review", "--print-config", "--config", overridePath], {
      cwd,
      evaluator,
    });
    expect(overridden.exitCode).toBe(0);
    // SAFETY: --print-config only prints the loaded JevLintConfig.
    const overriddenConfig = JSON.parse(overridden.stdout) as { rules: Record<string, { scope: string }> };
    expect(overriddenConfig.rules["jev/no-pass-through-wrapper"]).toBeUndefined();
    expect(evaluator.calls).toBe(0);
  });

  it("shows distinct help for review and audit", async () => {
    const review = await invoke(["review", "--help"], {
      cwd: process.cwd(),
      evaluator: new CountingEvaluator(),
    });
    expect(review.exitCode).toBe(0);
    expect(review.stdout).toContain("Usage: jevlint review [PATH]...");
    expect(review.stdout).toContain("Defaults to changed files");

    const audit = await invoke(["audit", "--help"], {
      cwd: process.cwd(),
      evaluator: new CountingEvaluator(),
    });
    expect(audit.exitCode).toBe(0);
    expect(audit.stdout).toContain("Usage: jevlint audit [PATH]...");
    expect(audit.stdout).toContain("Defaults to every source");

    const general = await invoke(["--help"], {
      cwd: process.cwd(),
      evaluator: new CountingEvaluator(),
    });
    expect(general.exitCode).toBe(0);
    expect(general.stdout).toContain("jevlint review [PATH]...");
    expect(general.stdout).toContain("jevlint audit [PATH]...");
  });
});
