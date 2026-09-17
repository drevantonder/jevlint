import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("applies display filters after evaluating all judgments", async () => {
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
    expect(report.judgments).toEqual([expect.objectContaining({ probability: 0.99 })]);
  });

  it("keeps diff as an output-identical compatibility alias", async () => {
    const { cwd, path } = await repository(
      "jevlint-cli-alias-",
      "export function wrap(value: string) { return target(value); }\n",
    );
    await writeFile(path, "export function wrap(value: string) { return target(value.trim()); }\n");
    const outputs: string[] = [];

    for (const command of ["review", "diff"]) {
      let stdout = "";
      const exitCode = await runCli([command, "--format", "json"], {
        cwd,
        evaluator: new PassThroughEvaluator(),
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => undefined,
      });
      expect(exitCode).toBe(0);
      outputs.push(stdout);
    }

    expect(outputs[1]).toBe(outputs[0]);
  });

  it("reports cache status only when verbose output is requested", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevlint-cli-cache-"));
    await execFile("git", ["init", "-q"], { cwd });
    let stderr = "";
    const exitCode = await runCli(["review", "--no-cache", "--verbose"], {
      cwd,
      evaluator: new PassThroughEvaluator(),
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("jevlint cache: disabled\n");
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
    expect(stderr).toContain("Usage: jevlint review");
  });
});
