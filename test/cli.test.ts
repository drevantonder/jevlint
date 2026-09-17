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
      JSON.stringify(question).includes("jev/no-pass-through-wrapper") ? 0.99 : 0,
    ]));
  }
}

describe("runCli", () => {
  it("lints changed candidates and writes diagnostics", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevlint-cli-"));
    await execFile("git", ["init", "-q"], { cwd });
    await execFile("git", ["config", "user.name", "Test"], { cwd });
    await execFile("git", ["config", "user.email", "test@example.com"], { cwd });
    const path = join(cwd, "wrapper.ts");
    await writeFile(path, "export function wrap(value: string) {\n  return target(value);\n}\n");
    await execFile("git", ["add", "."], { cwd });
    await execFile("git", ["commit", "-qm", "initial"], { cwd });
    await writeFile(path, "export function wrap(value: string) {\n  return target(value.trim());\n}\n");

    let stdout = "";
    let stderr = "";
    const exitCode = await runCli(["diff"], {
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
    expect(stdout).toContain("wrapper.ts:1:8  warning");
    expect(stdout).toContain("jev/no-pass-through-wrapper (0.99)");
  });

  it("reports cache status only when verbose output is requested", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevlint-cli-cache-"));
    await execFile("git", ["init", "-q"], { cwd });
    let stderr = "";
    const exitCode = await runCli(["diff", "--no-cache", "--verbose"], {
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
    const exitCode = await runCli(["diff", "--no-cache", "--refresh-cache"], {
      cwd: process.cwd(),
      evaluator: new PassThroughEvaluator(),
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(2);
    expect(stderr).toContain("Usage: jevlint diff");
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
    expect(stderr).toContain("Usage: jevlint diff");
  });
});
