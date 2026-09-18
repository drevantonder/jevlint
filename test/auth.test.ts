import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  authRejectionMessage,
  createChildKeytarStore,
  CredentialRejectedError,
  credentialsFilePath,
  isAuthFailure,
  LOOSE_PERMISSIONS_WARNING,
  MISSING_CREDENTIAL_MESSAGE,
  promptForApiKey,
  readKeyFromStdin,
  removeStoredCredential,
  resolveCredential,
  resolveCredentialWithIO,
  resetCredentialCache,
  SETUP_CANCELLED_MESSAGE,
  storeCredential,
  STORED_REMOVED_MESSAGE,
} from "../src/auth.js";
import type { AuthIO, KeychainSpawn, KeytarStore, PromptStdin } from "../src/auth.js";
import { runKeychainHelper } from "../src/keychain-helper.js";
import { runCli } from "../src/cli.js";
import type { CliDependencies } from "../src/cli.js";
import type { EvaluationRequest, Evaluator } from "../src/types.js";

const execFile = promisify(execFileCallback);

const CANARY = "canary-jevlint-auth-9f2c7be41d84a6f0c3e5";

class MemoryKeytar implements KeytarStore {
  readonly values = new Map<string, string>();
  writes = 0;
  removes = 0;

  private key(service: string, account: string): string {
    return `${service}/${account}`;
  }

  async getPassword(service: string, account: string): Promise<string | null> {
    return this.values.get(this.key(service, account)) ?? null;
  }

  async setPassword(service: string, account: string, password: string): Promise<void> {
    this.writes += 1;
    this.values.set(this.key(service, account), password);
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    this.removes += 1;
    return this.values.delete(this.key(service, account));
  }
}

// Simulates the helper child dying on timeout: the spawn rejects, and every
// keychain call must degrade instead of hanging the run.
function killedSpawn(): KeychainSpawn {
  return async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    throw new Error("helper timed out");
  };
}

interface FakeIOOptions {
  env?: NodeJS.ProcessEnv;
  keytar?: KeytarStore | "absent";
  varlockValue?: string | undefined;
  warnings?: string[];
}

async function fakeIO(home: string, options: FakeIOOptions = {}): Promise<AuthIO> {
  const keytar = options.keytar === undefined ? new MemoryKeytar() : options.keytar;
  const io: AuthIO = {
    env: options.env ?? {},
    homeDir: home,
    cwd: home,
    loadKeytar: async () => (keytar === "absent" ? undefined : keytar),
    readVarlock: async () => options.varlockValue,
    warn: (message: string) => {
      options.warnings?.push(message);
    },
  };
  return io;
}

async function tempHome(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function seedConfigFile(io: AuthIO, typesafeApiKey: string): Promise<void> {
  const path = credentialsFilePath(io);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ version: 1, typesafeApiKey }));
}

const CHANGED_FUNCTION = "export function wrap(value: string) {\n  return target(value.trim());\n}\n";

function ttyStdin(chunks: string[]): PromptStdin {
  const stream = new Readable({ read() {} });
  const stdin: PromptStdin = Object.assign(stream, { isTTY: true });
  for (const chunk of chunks) stream.push(chunk);
  return stdin;
}

function pipeStdin(chunks: string[], ended = true): PromptStdin {
  const stream = new Readable({ read() {} });
  const stdin: PromptStdin = Object.assign(stream, { isTTY: false });
  for (const chunk of chunks) stream.push(chunk);
  if (ended) stream.push(null);
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

describe("credential precedence", () => {
  it("prefers the flag over every backend", async () => {
    const home = await tempHome("jevlint-auth-flag-");
    const keytar = new MemoryKeytar();
    keytar.values.set("jevlint/typesafe-api-key", "keychain-value");
    const io = await fakeIO(home, {
      env: { JEVLINT_TYPESAFE_API_KEY: "env-value" },
      keytar,
      varlockValue: "varlock-value",
    });
    await seedConfigFile(io, "file-value");
    const resolved = await resolveCredentialWithIO({ tokenFlag: "flag-value" }, io);
    expect(resolved).toEqual({ token: "flag-value", source: "flag" });
  });

  it("prefers env over keychain, file, and varlock", async () => {
    const home = await tempHome("jevlint-auth-env-");
    const keytar = new MemoryKeytar();
    keytar.values.set("jevlint/typesafe-api-key", "keychain-value");
    const io = await fakeIO(home, {
      env: { JEVLINT_TYPESAFE_API_KEY: "env-value" },
      keytar,
      varlockValue: "varlock-value",
    });
    await seedConfigFile(io, "file-value");
    const resolved = await resolveCredentialWithIO({}, io);
    expect(resolved).toEqual({ token: "env-value", source: "env" });
  });

  it("prefers keychain over file and varlock", async () => {
    const home = await tempHome("jevlint-auth-keychain-");
    const keytar = new MemoryKeytar();
    keytar.values.set("jevlint/typesafe-api-key", "keychain-value");
    const io = await fakeIO(home, { keytar, varlockValue: "varlock-value" });
    await seedConfigFile(io, "file-value");
    const resolved = await resolveCredentialWithIO({}, io);
    expect(resolved).toEqual({ token: "keychain-value", source: "keychain" });
  });

  it("prefers the config file over varlock", async () => {
    const home = await tempHome("jevlint-auth-file-");
    const io = await fakeIO(home, { keytar: "absent", varlockValue: "varlock-value" });
    await seedConfigFile(io, "file-value");
    const resolved = await resolveCredentialWithIO({}, io);
    expect(resolved).toEqual({ token: "file-value", source: "config-file" });
  });

  it("falls back to varlock last", async () => {
    const home = await tempHome("jevlint-auth-varlock-");
    const io = await fakeIO(home, { keytar: "absent", varlockValue: "varlock-value" });
    const resolved = await resolveCredentialWithIO({}, io);
    expect(resolved).toEqual({ token: "varlock-value", source: "varlock" });
  });

  it("resolves nothing when every backend is empty", async () => {
    const home = await tempHome("jevlint-auth-empty-");
    const io = await fakeIO(home, { keytar: "absent", varlockValue: undefined });
    expect(await resolveCredentialWithIO({}, io)).toBeUndefined();
    expect(await resolveCredentialWithIO({ tokenFlag: "   " }, io)).toBeUndefined();
  });

  it("treats a corrupt credentials file as absent", async () => {
    const home = await tempHome("jevlint-auth-corrupt-");
    const io = await fakeIO(home, { keytar: "absent", varlockValue: "varlock-value" });
    await mkdir(dirname(credentialsFilePath(io)), { recursive: true });
    await writeFile(credentialsFilePath(io), "not json{{{");
    const resolved = await resolveCredentialWithIO({}, io);
    expect(resolved).toEqual({ token: "varlock-value", source: "varlock" });
  });

  it("warns but proceeds on a group-readable credentials file", async () => {
    const home = await tempHome("jevlint-auth-perms-");
    const warnings: string[] = [];
    const io = await fakeIO(home, { keytar: "absent", warnings });
    const path = credentialsFilePath(io);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ version: 1, typesafeApiKey: "file-value" }));
    await chmod(path, 0o644);
    const resolved = await resolveCredentialWithIO({}, io);
    expect(resolved).toEqual({ token: "file-value", source: "config-file" });
    expect(warnings).toEqual([LOOSE_PERMISSIONS_WARNING]);
  });
});

describe("flag secrecy", () => {
  it("never persists the flag value to keychain or file", async () => {
    const home = await tempHome("jevlint-auth-no-persist-");
    const keytar = new MemoryKeytar();
    const io = await fakeIO(home, { keytar });
    const resolved = await resolveCredentialWithIO({ tokenFlag: CANARY }, io);
    expect(resolved).toEqual({ token: CANARY, source: "flag" });
    expect(keytar.writes).toBe(0);
    expect(keytar.values.size).toBe(0);
    await expect(readFile(credentialsFilePath(io), "utf8")).rejects.toThrow();
  });
});

describe("storage", () => {
  it("stores to the keychain when available, then re-resolves from it", async () => {
    const home = await tempHome("jevlint-auth-store-kc-");
    const keytar = new MemoryKeytar();
    const io = await fakeIO(home, { keytar });
    expect(await storeCredential("stored-value", io)).toBe("keychain");
    expect(await resolveCredentialWithIO({}, io)).toEqual({
      token: "stored-value",
      source: "keychain",
    });
  });

  it("falls through a killed helper to the file backend", async () => {
    const home = await tempHome("jevlint-auth-hang-read-");
    const io = await fakeIO(home, { keytar: createChildKeytarStore(killedSpawn()) });
    await seedConfigFile(io, "file-value");
    const resolved = await resolveCredentialWithIO({}, io);
    expect(resolved).toEqual({ token: "file-value", source: "config-file" });
  });

  it("falls back to file when helper writes die", async () => {
    const home = await tempHome("jevlint-auth-hang-write-");
    const io = await fakeIO(home, { keytar: createChildKeytarStore(killedSpawn()) });
    expect(await storeCredential("stored-value", io)).toBe("config-file");
    expect(await resolveCredentialWithIO({}, io)).toEqual({
      token: "stored-value",
      source: "config-file",
    });
  });

  it("still clears the file when helper removal dies", async () => {
    const home = await tempHome("jevlint-auth-hang-remove-");
    const io = await fakeIO(home, { keytar: createChildKeytarStore(killedSpawn()) });
    await seedConfigFile(io, "file-value");
    await removeStoredCredential(io);
    expect(await resolveCredentialWithIO({}, io)).toBeUndefined();
  });

  it("degrades to a 0600 file when keytar is unresolvable", async () => {
    const home = await tempHome("jevlint-auth-store-file-");
    const io = await fakeIO(home, { keytar: "absent" });
    expect(await storeCredential("stored-value", io)).toBe("config-file");
    const path = credentialsFilePath(io);
    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
    expect(await resolveCredentialWithIO({}, io)).toEqual({
      token: "stored-value",
      source: "config-file",
    });
  });

  it("overwrites on re-store and removes from both backends on forget", async () => {
    const home = await tempHome("jevlint-auth-overwrite-");
    const keytar = new MemoryKeytar();
    const io = await fakeIO(home, { keytar });
    await storeCredential("first", io);
    await storeCredential("second", io);
    expect(await resolveCredentialWithIO({}, io)).toEqual({
      token: "second",
      source: "keychain",
    });
    await removeStoredCredential(io);
    expect(await resolveCredentialWithIO({}, io)).toBeUndefined();
    expect(keytar.values.size).toBe(0);
    await expect(readFile(credentialsFilePath(io), "utf8")).rejects.toThrow();
  });

  it("forget clears a file-only credential without a keychain", async () => {
    const home = await tempHome("jevlint-auth-forget-file-");
    const io = await fakeIO(home, { keytar: "absent" });
    await storeCredential("file-only", io);
    await removeStoredCredential(io);
    expect(await resolveCredentialWithIO({}, io)).toBeUndefined();
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

  it("reads a piped key to EOF for --stdin", async () => {
    const token = await readKeyFromStdin(pipeStdin([CANARY]));
    expect(token).toBe(CANARY);
  });
});

describe("setup command", () => {
  it("stores a piped key and reports storage without leaking it", async () => {
    const home = await tempHome("jevlint-setup-stdin-");
    const io = await fakeIO(home, { keytar: "absent" });
    const cwd = await repository("jevlint-setup-stdin-repo-");
    const result = await invoke(["setup", "--stdin"], {
      cwd,
      authIO: io,
      stdin: pipeStdin([CANARY]),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(CANARY);
    expect(result.stderr).not.toContain(CANARY);
    expect(result.stderr).toContain("API key stored (config file).");
    expect(await resolveCredentialWithIO({}, io)).toEqual({
      token: CANARY,
      source: "config-file",
    });
  });

  it("rejects an empty piped key", async () => {
    const home = await tempHome("jevlint-setup-empty-");
    const io = await fakeIO(home, { keytar: "absent" });
    const cwd = await repository("jevlint-setup-empty-repo-");
    const result = await invoke(["setup", "--stdin"], {
      cwd,
      authIO: io,
      stdin: pipeStdin(["   \n"]),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).not.toContain(CANARY);
  });

  it("forgets the stored credential from both backends", async () => {
    const home = await tempHome("jevlint-setup-forget-");
    const keytar = new MemoryKeytar();
    const io = await fakeIO(home, { keytar });
    const cwd = await repository("jevlint-setup-forget-repo-");
    await storeCredential("doomed", io);
    const result = await invoke(["setup", "--forget"], { cwd, authIO: io });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(STORED_REMOVED_MESSAGE);
    expect(await resolveCredentialWithIO({}, io)).toBeUndefined();
  });

  it("fails fast without a TTY instead of prompting", async () => {
    const home = await tempHome("jevlint-setup-notty-");
    const io = await fakeIO(home, { keytar: "absent" });
    const cwd = await repository("jevlint-setup-notty-repo-");
    const result = await invoke(["setup"], {
      cwd,
      authIO: io,
      stdin: pipeStdin([], true),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe(`${MISSING_CREDENTIAL_MESSAGE}\n`);
  });

  it("rejects --token on setup", async () => {
    const home = await tempHome("jevlint-setup-token-");
    const io = await fakeIO(home, { keytar: "absent" });
    const cwd = await repository("jevlint-setup-token-repo-");
    const result = await invoke(["setup", "--token", CANARY], { cwd, authIO: io });
    expect(result.exitCode).toBe(2);
    expect(result.stdout).not.toContain(CANARY);
    expect(result.stderr).not.toContain(CANARY);
    expect(await resolveCredentialWithIO({}, io)).toBeUndefined();
  });
});

describe("live-run credential flow", () => {
  it("prompts on first run, stores, and continues without leaking the key", async () => {
    const home = await tempHome("jevlint-firstrun-");
    const io = await fakeIO(home, { keytar: "absent" });
    const cwd = await repository("jevlint-firstrun-repo-");
    const result = await invoke(["review"], {
      cwd,
      authIO: io,
      stdin: ttyStdin([`${CANARY}\n`]),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain(CANARY);
    expect(result.stderr).not.toContain(CANARY);
    expect(await resolveCredentialWithIO({}, io)).toEqual({
      token: CANARY,
      source: "config-file",
    });
  });

  it("fails fast with the generic error on non-TTY with no credential", async () => {
    const home = await tempHome("jevlint-nontry-");
    const io = await fakeIO(home, { keytar: "absent" });
    const cwd = await repository("jevlint-nontry-repo-");
    const result = await invoke(["review", "--format", "json"], {
      cwd,
      authIO: io,
      stdin: pipeStdin([], true),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe(`${MISSING_CREDENTIAL_MESSAGE}\n`);
    expect(result.stdout).toBe("");
  });

  it("honors --no-prompt on a TTY", async () => {
    const home = await tempHome("jevlint-noprompt-");
    const io = await fakeIO(home, { keytar: "absent" });
    const cwd = await repository("jevlint-noprompt-repo-");
    const result = await invoke(["review", "--no-prompt"], {
      cwd,
      authIO: io,
      stdin: ttyStdin([]),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe(`${MISSING_CREDENTIAL_MESSAGE}\n`);
  });

  it("maps a rejected key to the auth-fix error with the source label", async () => {
    const home = await tempHome("jevlint-rejected-");
    const io = await fakeIO(home, {
      env: { JEVLINT_TYPESAFE_API_KEY: CANARY },
      keytar: "absent",
    });
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
    const io = await fakeIO(home, {
      env: { JEVLINT_TYPESAFE_API_KEY: CANARY },
      keytar: "absent",
    });
    const cwd = await repository("jevlint-canary-flags-repo-");
    await writeFile(join(cwd, "changed.ts"), CHANGED_FUNCTION);
    for (const args of [
      ["--print-config"],
      ["review", "--print-config"],
      ["review", "--debug=files"],
      ["review", "--format", "json", "--debug=cache"],
      ["review", "--format", "json", "--token", CANARY, "--debug=timings"],
    ]) {
      const result = await invoke(args, {
        cwd,
        evaluator: new PassEvaluator(),
        authIO: io,
        stdin: pipeStdin([], true),
      });
      expect(result.stdout).not.toContain(CANARY);
      expect(result.stderr).not.toContain(CANARY);
    }
  });

  it("leaves --print-config output free of auth fields", async () => {
    const home = await tempHome("jevlint-print-config-");
    const io = await fakeIO(home, { keytar: "absent" });
    const cwd = await repository("jevlint-print-config-repo-");
    const result = await invoke(["review", "--print-config"], { cwd, authIO: io });
    expect(result.exitCode).toBe(0);
    // SAFETY: --print-config emits the effective review config as JSON; this test only reads its top-level keys.
    const parsed = JSON.parse(result.stdout) as { rules: unknown };
    expect(Object.keys(parsed)).toEqual(["rules"]);
  });
});

describe("keychain helper", () => {
  it("dispatches get/set/delete against the loaded store", async () => {
    const keytar = new MemoryKeytar();
    const load = async (): Promise<KeytarStore | undefined> => keytar;
    expect(await runKeychainHelper(["set", "svc", "acct"], "secret-value", load)).toEqual({
      exitCode: 0,
      output: "",
    });
    expect(await runKeychainHelper(["get", "svc", "acct"], "", load)).toEqual({
      exitCode: 0,
      output: "secret-value",
    });
    expect(await runKeychainHelper(["get", "svc", "missing"], "", load)).toEqual({
      exitCode: 0,
      output: "",
    });
    expect(await runKeychainHelper(["delete", "svc", "acct"], "", load)).toEqual({
      exitCode: 0,
      output: "",
    });
    expect(await runKeychainHelper(["get", "svc", "acct"], "", load)).toEqual({
      exitCode: 0,
      output: "",
    });
  });

  it("rejects bad argv and missing stores without output", async () => {
    const keytar = new MemoryKeytar();
    const load = async (): Promise<KeytarStore | undefined> => keytar;
    expect(await runKeychainHelper(["bogus", "s", "a"], "", load)).toEqual({
      exitCode: 1,
      output: "",
    });
    expect(await runKeychainHelper(["get", "s"], "", load)).toEqual({
      exitCode: 1,
      output: "",
    });
    expect(await runKeychainHelper(["get", "s", "a"], "", async () => undefined)).toEqual({
      exitCode: 1,
      output: "",
    });
  });

  it("probes the real keychain read-only without leaking", async () => {
    const result = await runKeychainHelper(["get", "jevlint", "probe-no-such-entry"], "");
    expect(result.output).toBe("");
    expect([0, 1]).toContain(result.exitCode);
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
    expect(new CredentialRejectedError("flag") instanceof CredentialRejectedError).toBe(true);
    expect(new Error("nope") instanceof CredentialRejectedError).toBe(false);
    expect(new CredentialRejectedError("varlock").message).toBe(authRejectionMessage("varlock"));
    expect(new CredentialRejectedError("varlock").source).toBe("varlock");
  });
});

describe("credential cache", () => {
  it("memoizes the default resolution", async () => {
    resetCredentialCache();
    const prior = process.env.JEVLINT_TYPESAFE_API_KEY;
    process.env.JEVLINT_TYPESAFE_API_KEY = "memo-canary";
    try {
      const first = await resolveCredential({});
      const second = await resolveCredential({});
      expect(first).toEqual({ token: "memo-canary", source: "env" });
      expect(second).toBe(first);
    } finally {
      if (prior === undefined) delete process.env.JEVLINT_TYPESAFE_API_KEY;
      else process.env.JEVLINT_TYPESAFE_API_KEY = prior;
      resetCredentialCache();
    }
  });
});
