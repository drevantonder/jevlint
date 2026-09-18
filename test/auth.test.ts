import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  authRejectionMessage,
  CredentialRejectedError,
  isAuthFailure,
  MISSING_CREDENTIAL_MESSAGE,
  resolveCredential,
  resolveCredentialWithIO,
} from "../src/auth.js";
import type { AuthIO } from "../src/auth.js";
import { runCli } from "../src/cli.js";
import type { CliDependencies } from "../src/cli.js";
import type { EvaluationRequest, Evaluator } from "../src/types.js";

const execFile = promisify(execFileCallback);

const CANARY = "canary-jevlint-auth-9f2c7be41d84a6f0c3e5";

function fakeIO(env: NodeJS.ProcessEnv = {}): AuthIO {
  return { env };
}

async function repository(prefix: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  await execFile("git", ["init", "-q"], { cwd });
  await execFile("git", ["config", "user.name", "Test"], { cwd });
  await execFile("git", ["config", "user.email", "test@example.com"], { cwd });
  await writeFile(join(cwd, "notes.txt"), "nothing to score\n");
  await execFile("git", ["add", "."], { cwd });
  await execFile("git", ["commit", "-qm", "initial"], { cwd });
  return cwd;
}

const CHANGED_FUNCTION = "export function wrap(value: string) {\n  return target(value.trim());\n}\n";

interface CliCapture {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function invoke(
  args: string[],
  options: { cwd: string; evaluator?: Evaluator; authIO?: AuthIO },
): Promise<CliCapture> {
  let stdout = "";
  let stderr = "";
  const dependencies: CliDependencies = {
    cwd: options.cwd,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  if (options.evaluator !== undefined) dependencies.evaluator = options.evaluator;
  if (options.authIO !== undefined) dependencies.authIO = options.authIO;
  const exitCode = await runCli(args, dependencies);
  return { stdout, stderr, exitCode };
}

class ThrowingAuthEvaluator implements Evaluator {
  async evaluate(): Promise<Record<string, number>> {
    throw new CredentialRejectedError("env");
  }
}

class PassEvaluator implements Evaluator {
  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, 0.1]));
  }
}

describe("credential resolution", () => {
  it("reads TYPESAFE_API_KEY and nothing else", () => {
    expect(resolveCredentialWithIO(fakeIO({ TYPESAFE_API_KEY: "shared-value" }))).toEqual({
      token: "shared-value",
      source: "env",
    });
  });

  it("treats missing, empty, and blank values as absent", () => {
    expect(resolveCredentialWithIO(fakeIO({}))).toBeUndefined();
    expect(resolveCredentialWithIO(fakeIO({ TYPESAFE_API_KEY: "" }))).toBeUndefined();
    expect(resolveCredentialWithIO(fakeIO({ TYPESAFE_API_KEY: "   " }))).toBeUndefined();
  });

  it("ignores every other variable name", () => {
    const io = fakeIO({
      JEVLINT_TYPESAFE_API_KEY: "legacy-value",
      TYPESAFE_API_KEY_2: "near-miss",
      GITHUB_TOKEN: "unrelated",
    });
    expect(resolveCredentialWithIO(io)).toBeUndefined();
  });

  it("reads the live process environment without caching", () => {
    const prior = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "live-canary";
    try {
      expect(resolveCredential()).toEqual({ token: "live-canary", source: "env" });
      delete process.env.TYPESAFE_API_KEY;
      expect(resolveCredential()).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = prior;
    }
  });
});

describe("no setup command", () => {
  it("rejects the removed setup subcommand without leaking", async () => {
    const cwd = await repository("jevlint-no-setup-repo-");
    for (const args of [["setup"], ["setup", "--forget"]]) {
      const result = await invoke(args, { cwd, authIO: fakeIO({}) });
      expect(result.exitCode).toBe(2);
      expect(result.stdout).not.toContain(CANARY);
      expect(result.stderr).not.toContain(CANARY);
    }
  });

  it("rejects the removed --stdin, --token, and --no-prompt flags without leaking", async () => {
    const cwd = await repository("jevlint-no-flags-repo-");
    for (const args of [
      ["review", "--stdin"],
      ["review", "--token", CANARY],
      ["review", "--no-prompt"],
      ["audit", "--token", CANARY],
      ["audit", "--no-prompt"],
    ]) {
      const result = await invoke(args, { cwd, authIO: fakeIO({}) });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Usage: jevlint");
      expect(result.stdout).not.toContain(CANARY);
      expect(result.stderr).not.toContain(CANARY);
    }
  });
});

describe("live-run credential flow", () => {
  it("runs with the key from the environment without leaking it", async () => {
    const io = fakeIO({ TYPESAFE_API_KEY: CANARY });
    const cwd = await repository("jevlint-live-env-repo-");
    const result = await invoke(["review"], { cwd, authIO: io });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(CANARY);
    expect(result.stderr).not.toContain(CANARY);
  });

  it("fails fast with the generic error when the key is missing or empty", async () => {
    const cwd = await repository("jevlint-live-missing-repo-");
    for (const env of [{}, { TYPESAFE_API_KEY: "" }, { TYPESAFE_API_KEY: "   " }]) {
      for (const args of [
        ["review", "--format", "json"],
        ["audit", "--format", "json"],
      ]) {
        const result = await invoke(args, { cwd, authIO: fakeIO(env) });
        expect(result.exitCode).toBe(2);
        expect(result.stderr).toBe(`${MISSING_CREDENTIAL_MESSAGE}\n`);
        expect(result.stdout).toBe("");
        expect(result.stdout).not.toContain(CANARY);
        expect(result.stderr).not.toContain(CANARY);
      }
    }
  });

  it("names the variable in the missing-key error", () => {
    expect(MISSING_CREDENTIAL_MESSAGE).toContain("TYPESAFE_API_KEY");
  });

  it("maps a rejected key to the auth-fix error with the source label", async () => {
    const io = fakeIO({ TYPESAFE_API_KEY: CANARY });
    const cwd = await repository("jevlint-rejected-repo-");
    await writeFile(join(cwd, "changed.ts"), CHANGED_FUNCTION);
    const result = await invoke(["review", "--format", "json"], {
      cwd,
      evaluator: new ThrowingAuthEvaluator(),
      authIO: io,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain(authRejectionMessage("env"));
    expect(result.stdout).not.toContain(CANARY);
    expect(result.stderr).not.toContain(CANARY);
  });

  it("keeps --debug and --print-config output free of the key", async () => {
    const io = fakeIO({ TYPESAFE_API_KEY: CANARY });
    const cwd = await repository("jevlint-canary-flags-repo-");
    await writeFile(join(cwd, "changed.ts"), CHANGED_FUNCTION);
    for (const args of [
      ["--print-config"],
      ["review", "--print-config"],
      ["review", "--debug=files"],
      ["review", "--format", "json", "--debug=cache"],
      ["review", "--format", "json", "--debug=timings"],
    ]) {
      const result = await invoke(args, {
        cwd,
        evaluator: new PassEvaluator(),
        authIO: io,
      });
      expect(result.stdout).not.toContain(CANARY);
      expect(result.stderr).not.toContain(CANARY);
    }
  });

  it("keeps --out-dir artifacts and summary.json free of the key", async () => {
    const io = fakeIO({ TYPESAFE_API_KEY: CANARY });
    const cwd = await repository("jevlint-canary-outdir-repo-");
    await writeFile(join(cwd, "changed.ts"), "export function wrap(value: string) {\n  return value;\n}\n");
    await execFile("git", ["add", "."], { cwd });
    await execFile("git", ["commit", "-qm", "add changed"], { cwd });
    await writeFile(join(cwd, "changed.ts"), CHANGED_FUNCTION);
    const outDir = join(cwd, "out");
    const result = await invoke(["review", "--out-dir", outDir], {
      cwd,
      evaluator: new PassEvaluator(),
      authIO: io,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(CANARY);
    expect(result.stderr).not.toContain(CANARY);
    // SAFETY: --out-dir artifacts mirror the report; assert on raw text, never the key.
    const summary = await readFile(join(outDir, "summary.json"), "utf8");
    expect(summary).not.toContain(CANARY);
    const artifact = await readFile(join(outDir, "changed.ts.json"), "utf8");
    expect(artifact).not.toContain(CANARY);
  });

  it("leaves --print-config output free of auth fields", async () => {
    const cwd = await repository("jevlint-print-config-repo-");
    const result = await invoke(["review", "--print-config"], { cwd, authIO: fakeIO({}) });
    expect(result.exitCode).toBe(0);
    // SAFETY: --print-config emits the effective review config as JSON; this test only reads its top-level keys.
    const parsed = JSON.parse(result.stdout) as { rules: unknown };
    expect(Object.keys(parsed)).toEqual(["rules"]);
  });
});

describe("auth error shapes", () => {
  it("recognizes 401/403 statuses and SDK auth names only", () => {
    const withStatus = (status: number): Error =>
      Object.assign(new Error(`${status}`), { status });
    expect(isAuthFailure(withStatus(401))).toBe(true);
    expect(isAuthFailure(withStatus(403))).toBe(true);
    expect(isAuthFailure(withStatus(429))).toBe(false);
    expect(isAuthFailure(Object.assign(new Error("denied"), { name: "PermissionDeniedError" }))).toBe(
      true,
    );
    expect(isAuthFailure(Object.assign(new Error("bad"), { name: "AuthenticationError" }))).toBe(
      true,
    );
    expect(isAuthFailure(new Error("boom"))).toBe(false);
    expect(isAuthFailure(new Error("401"))).toBe(false);
    expect(new CredentialRejectedError("env") instanceof CredentialRejectedError).toBe(true);
    expect(new Error("nope") instanceof CredentialRejectedError).toBe(false);
    expect(new CredentialRejectedError("env").message).toBe(authRejectionMessage("env"));
    expect(new CredentialRejectedError("env").source).toBe("env");
  });
});
