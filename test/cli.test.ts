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

class PartialEvaluator implements Evaluator {
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    if (request.state.candidates.some((candidate) => candidate.source.includes("broken"))) {
      throw new Error("400 max_tokens_exceeded");
    }
    return Object.fromEntries(Object.entries(request.questions).map(([id, question]) => [
      id,
      JSON.stringify(question).includes("synthetic function") ? 0.99 : 0,
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

  it("writes partial JSON diagnostics and bounded evaluation failures", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "jevlint-cli-partial-"));
    await execFile("git", ["init", "-q"], { cwd });
    await execFile("git", ["config", "user.name", "Test"], { cwd });
    await execFile("git", ["config", "user.email", "test@example.com"], { cwd });
    const path = join(cwd, "functions.ts");
    await writeFile(path, "export function first() { return 0; }\nexport function broken() { return 0; }\n");
    await execFile("git", ["add", "."], { cwd });
    await execFile("git", ["commit", "-qm", "initial"], { cwd });
    await writeFile(path, "export function first() { return 1; }\nexport function broken() { return 1; }\n");
    await writeFile(join(cwd, "jevlint.config.mjs"), `export default {
      rules: {
        "test/function": {
          scope: "function",
          question: { instructions: "Is this a synthetic function?" },
          threshold: 0.8,
          severity: "warning",
          message: "Synthetic function found."
        }
      }
    };\n`);

    let stdout = "";
    let stderr = "";
    const exitCode = await runCli(["diff", "--format", "json"], {
      cwd,
      evaluator: new PartialEvaluator(),
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(stdout)).toEqual([
      expect.objectContaining({ filePath: "functions.ts", ruleId: "test/function" }),
    ]);
    expect(stderr).toContain("functions.ts: 1 evaluation question failed");
    expect(stderr).toContain("max_tokens_exceeded");
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
