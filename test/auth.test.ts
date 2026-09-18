import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  authRejectionMessage,
  CredentialRejectedError,
  installShellKey,
  isAuthFailure,
  MISSING_CREDENTIAL_MESSAGE,
  promptForApiKey,
  removeShellKey,
  resolveCredential,
  resolveCredentialWithIO,
  SETUP_CANCELLED_MESSAGE,
  SETUP_NON_TTY_MESSAGE,
  shellExportLine,
  SHELL_MARKER,
  STORED_REMOVED_MESSAGE,
} from "../src/auth.js";
import type { AuthIO, PromptStdin } from "../src/auth.js";
import { runCli } from "../src/cli.js";
import type { CliDependencies } from "../src/cli.js";
import type { EvaluationRequest, Evaluator } from "../src/types.js";

const execFile = promisify(execFileCallback);

const CANARY = "canary-jevlint-auth-9f2c7be41d84a6f0c3e5";

function fakeIO(home: string, env: NodeJS.ProcessEnv = {}): AuthIO {
  return { env, homeDir: home };
}

async function tempHome(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function ttyStdin(chunks: string[]): PromptStdin {
  const stream = new Readable({ read() {} });
  const stdin: PromptStdin = Object.assign(stream, { isTTY: true });
  for (const chunk of chunks) stream.push(chunk);
  return stdin;
}

function pipeStdin(chunks: string[]): PromptStdin {
  const stream = new Readable({ read() {} });
  const stdin: PromptStdin = Object.assign(stream, { isTTY: false });
  for (const chunk of chunks) stream.push(chunk);
  stream.push(null);
  return stdin;
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
  options: { cwd: string; evaluator?: Evaluator; authIO?: AuthIO; stdin?: PromptStdin },
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
  if (options.stdin !== undefined) dependencies.stdin = options.stdin;
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
  it("reads TYPESAFE_API_KEY and nothing else", async () => {
    const home = await tempHome("jevlint-auth-env-");
    expect(resolveCredentialWithIO(fakeIO(home, { TYPESAFE_API_KEY: "shared-value" }))).toEqual({
      token: "shared-value",
      source: "env",
    });
  });

  it("treats missing, empty, and blank values as absent", async () => {
    const home = await tempHome("jevlint-auth-empty-");
    expect(resolveCredentialWithIO(fakeIO(home, {}))).toBeUndefined();
    expect(resolveCredentialWithIO(fakeIO(home, { TYPESAFE_API_KEY: "" }))).toBeUndefined();
    expect(resolveCredentialWithIO(fakeIO(home, { TYPESAFE_API_KEY: "   " }))).toBeUndefined();
  });

  it("ignores every other variable name", async () => {
    const home = await tempHome("jevlint-auth-names-");
    const io = fakeIO(home, {
      JEVLINT_TYPESAFE_API_KEY: "legacy-value",
      TYPESAFE_API_KEY_2: "near-miss",
      GITHUB_TOKEN: "unrelated",
    });
    expect(resolveCredentialWithIO(io)).toBeUndefined();
  });

  it("reads the live process environment without caching", async () => {
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

describe("shell startup files", () => {
  it("creates both rc files with 0600 and the marked export line", async () => {
    const home = await tempHome("jevlint-setup-create-");
    const results = await installShellKey(CANARY, fakeIO(home));
    expect(results.map((entry) => entry.display)).toEqual(["~/.bashrc", "~/.zshrc"]);
    expect(results.every((entry) => entry.created)).toBe(true);
    expect(results.every((entry) => entry.backup === undefined)).toBe(true);
    for (const file of [".bashrc", ".zshrc"]) {
      const path = join(home, file);
      const info = await stat(path);
      expect(info.mode & 0o777).toBe(0o600);
      const contents = await readFile(path, "utf8");
      expect(contents).toBe(`${shellExportLine(CANARY)}\n`);
    }
  });

  it("appends to existing files, backs them up, and keeps their content", async () => {
    const home = await tempHome("jevlint-setup-append-");
    await writeFile(join(home, ".bashrc"), "alias ll='ls -l'\n");
    const results = await installShellKey(CANARY, fakeIO(home));
    const bash = results.find((entry) => entry.display === "~/.bashrc");
    expect(bash?.created).toBe(false);
    expect(bash?.backup).toBe(join(home, ".bashrc.jevlint.bak"));
    expect(await readFile(join(home, ".bashrc.jevlint.bak"), "utf8")).toBe("alias ll='ls -l'\n");
    expect(await readFile(join(home, ".bashrc"), "utf8")).toBe(
      `alias ll='ls -l'\n${shellExportLine(CANARY)}\n`,
    );
  });

  it("replaces instead of duplicating on re-runs", async () => {
    const home = await tempHome("jevlint-setup-idempotent-");
    const io = fakeIO(home);
    await installShellKey("first-key", io);
    await installShellKey("second-key", io);
    await installShellKey("second-key", io);
    for (const file of [".bashrc", ".zshrc"]) {
      const contents = await readFile(join(home, file), "utf8");
      const managed = contents.split("\n").filter((line) => line.includes(SHELL_MARKER));
      expect(managed).toHaveLength(1);
      expect(managed[0]).toBe(shellExportLine("second-key"));
      expect(contents).not.toContain("first-key");
    }
  });

  it("quotes single quotes in the key", async () => {
    const home = await tempHome("jevlint-setup-quote-");
    await installShellKey("a'b", fakeIO(home));
    expect(await readFile(join(home, ".bashrc"), "utf8")).toBe(
      "export TYPESAFE_API_KEY='a'\\''b' # jevlint\n",
    );
  });

  it("refuses an empty key", async () => {
    const home = await tempHome("jevlint-setup-empty-");
    await expect(installShellKey("   ", fakeIO(home))).rejects.toThrow(
      "refusing to store an empty API key",
    );
  });

  it("removes managed lines while keeping user content", async () => {
    const home = await tempHome("jevlint-setup-forget-");
    const io = fakeIO(home);
    await installShellKey(CANARY, io);
    await writeFile(join(home, ".bashrc"), `${await readFile(join(home, ".bashrc"), "utf8")}alias ll='ls -l'\n`);
    const changed = await removeShellKey(io);
    expect(changed).toEqual(["~/.bashrc", "~/.zshrc"]);
    expect(await readFile(join(home, ".bashrc"), "utf8")).toBe("alias ll='ls -l'\n");
    expect(await readFile(join(home, ".zshrc"), "utf8")).toBe("");
    expect(resolveCredentialWithIO(fakeIO(home))).toBeUndefined();
  });

  it("forget is a no-op when nothing was ever saved", async () => {
    const home = await tempHome("jevlint-setup-forget-absent-");
    await expect(removeShellKey(fakeIO(home))).resolves.toEqual([]);
  });
});

describe("prompt", () => {
  it("reads hidden input without echoing the key", async () => {
    let stderr = "";
    const token = await promptForApiKey(ttyStdin([`${CANARY}\n`]), (text) => {
      stderr += text;
    });
    expect(token).toBe(CANARY);
    expect(stderr).not.toContain(CANARY);
  });

  it("cancels on Ctrl-C with the cancelled message", async () => {
    const stream = new Readable({ read() {} });
    const stdin: PromptStdin = Object.assign(stream, { isTTY: true });
    let stderr = "";
    const pending = promptForApiKey(stdin, (text) => {
      stderr += text;
    });
    stream.push("partial");
    stream.push("\u0003");
    await expect(pending).rejects.toThrow(SETUP_CANCELLED_MESSAGE);
    expect(stderr).not.toContain("partial");
  });
});

describe("setup command", () => {
  it("saves the key to shell files and names the restart step without leaking it", async () => {
    const home = await tempHome("jevlint-setup-cmd-");
    const io = fakeIO(home);
    const cwd = await repository("jevlint-setup-cmd-repo-");
    const result = await invoke(["setup"], { cwd, authIO: io, stdin: ttyStdin([`${CANARY}\n`]) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(CANARY);
    expect(result.stderr).not.toContain(CANARY);
    expect(result.stderr).toContain("API key saved to ~/.bashrc, ~/.zshrc.");
    expect(result.stderr).toContain("source ~/.bashrc");
    const contents = await readFile(join(home, ".bashrc"), "utf8");
    expect(contents).toBe(`${shellExportLine(CANARY)}\n`);
  });

  it("forgets the saved key", async () => {
    const home = await tempHome("jevlint-setup-cmd-forget-");
    const io = fakeIO(home);
    const cwd = await repository("jevlint-setup-cmd-forget-repo-");
    await installShellKey("doomed", io);
    const result = await invoke(["setup", "--forget"], { cwd, authIO: io });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(STORED_REMOVED_MESSAGE);
    expect(await removeShellKey(io)).toEqual([]);
  });

  it("needs a terminal instead of reading pipes", async () => {
    const home = await tempHome("jevlint-setup-cmd-notty-");
    const io = fakeIO(home);
    const cwd = await repository("jevlint-setup-cmd-notty-repo-");
    const result = await invoke(["setup"], { cwd, authIO: io, stdin: pipeStdin([CANARY]) });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe(`${SETUP_NON_TTY_MESSAGE}\n`);
    expect(await removeShellKey(io)).toEqual([]);
  });

  it("rejects the removed --stdin, --token, and --no-prompt flags without leaking", async () => {
    const home = await tempHome("jevlint-setup-cmd-flags-");
    const io = fakeIO(home);
    const cwd = await repository("jevlint-setup-cmd-flags-repo-");
    for (const args of [
      ["setup", "--stdin"],
      ["setup", "--token", CANARY],
      ["setup", "--no-prompt"],
      ["review", "--token", CANARY],
      ["review", "--no-prompt"],
    ]) {
      const result = await invoke(args, { cwd, authIO: io });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain("Usage: jevlint");
      expect(result.stdout).not.toContain(CANARY);
      expect(result.stderr).not.toContain(CANARY);
    }
    expect(await removeShellKey(io)).toEqual([]);
  });
});

describe("live-run credential flow", () => {
  it("runs with the key from the environment without leaking it", async () => {
    const home = await tempHome("jevlint-live-env-");
    const io = fakeIO(home, { TYPESAFE_API_KEY: CANARY });
    const cwd = await repository("jevlint-live-env-repo-");
    const result = await invoke(["review"], { cwd, authIO: io, stdin: pipeStdin([]) });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(CANARY);
    expect(result.stderr).not.toContain(CANARY);
  });

  it("fails fast with the generic error when the key is missing or empty", async () => {
    const home = await tempHome("jevlint-live-missing-");
    const cwd = await repository("jevlint-live-missing-repo-");
    for (const env of [{}, { TYPESAFE_API_KEY: "" }, { TYPESAFE_API_KEY: "   " }]) {
      const result = await invoke(["review", "--format", "json"], {
        cwd,
        authIO: fakeIO(home, env),
        stdin: pipeStdin([]),
      });
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toBe(`${MISSING_CREDENTIAL_MESSAGE}\n`);
      expect(result.stdout).toBe("");
      expect(result.stdout).not.toContain(CANARY);
      expect(result.stderr).not.toContain(CANARY);
    }
  });

  it("maps a rejected key to the auth-fix error with the source label", async () => {
    const home = await tempHome("jevlint-rejected-");
    const io = fakeIO(home, { TYPESAFE_API_KEY: CANARY });
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
    const home = await tempHome("jevlint-canary-flags-");
    const io = fakeIO(home, { TYPESAFE_API_KEY: CANARY });
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
        stdin: pipeStdin([]),
      });
      expect(result.stdout).not.toContain(CANARY);
      expect(result.stderr).not.toContain(CANARY);
    }
  });

  it("keeps --out-dir artifacts and summary.json free of the key", async () => {
    const home = await tempHome("jevlint-canary-outdir-");
    const io = fakeIO(home, { TYPESAFE_API_KEY: CANARY });
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
      stdin: pipeStdin([]),
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
    const home = await tempHome("jevlint-print-config-");
    const io = fakeIO(home);
    const cwd = await repository("jevlint-print-config-repo-");
    const result = await invoke(["review", "--print-config"], { cwd, authIO: io });
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
