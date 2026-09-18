import { execFile as execFileCallback, spawn } from "node:child_process";
import { chmod, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";

const execFile = promisify(execFileCallback);

export const ENV_VAR_NAME = "JEVLINT_TYPESAFE_API_KEY";
export const SHARED_ENV_VAR_NAME = "TYPESAFE_API_KEY";
export const KEYCHAIN_SERVICE = "jevlint";
export const KEYCHAIN_ACCOUNT = "typesafe-api-key";
export const CREDENTIALS_FILE_VERSION = 1;
const VARLOCK_TIMEOUT_MS = 15_000;
// Headless machines can block secret-service calls indefinitely instead of
// failing, and a wedged native call would hold the event loop past process
// exit. Keychain access therefore runs in the helper child (spawned per
// process, killed on timeout); the parent never loads keytar in-process.
const KEYCHAIN_HELPER_TIMEOUT_MS = 15_000;

export type CredentialSource = "flag" | "env-jevlint" | "env-shared" | "keychain" | "config-file" | "varlock";

export interface ResolvedCredential {
  token: string;
  source: CredentialSource;
}

export interface ResolveOptions {
  tokenFlag?: string | undefined;
}

export const MISSING_CREDENTIAL_MESSAGE =
  `jevlint: no Typesafe API key found. Set ${ENV_VAR_NAME} or run 'jevlint setup'.`;

export function authRejectionMessage(source: string): string {
  return `Typesafe rejected the API key (${source}). Run 'jevlint setup' to store a new key, or set ${ENV_VAR_NAME}.`;
}

export const SETUP_CANCELLED_MESSAGE = "jevlint: setup cancelled";
export const STORED_REMOVED_MESSAGE = "jevlint: stored credential removed";
export const STORED_PREFIX = "jevlint: API key stored";
export const PROMPT_TEXT = "Enter your Typesafe (Jev) API key: ";
export const EMPTY_STDIN_MESSAGE = "jevlint: no key received on stdin.";
export const LOOSE_PERMISSIONS_WARNING =
  "jevlint: warning: credentials file is group/world-readable; run jevlint setup to re-store";

export class CredentialRejectedError extends Error {
  readonly source: string;

  constructor(source: string) {
    super(authRejectionMessage(source));
    this.name = "CredentialRejectedError";
    this.source = source;
  }
}

export function isAuthFailure(error: Error): boolean {
  if (error.name === "AuthenticationError" || error.name === "PermissionDeniedError") return true;
  if ("status" in error) {
    const status = error.status;
    if (status === 401 || status === 403) return true;
  }
  return false;
}

export class SetupCancelledError extends Error {
  constructor() {
    super(SETUP_CANCELLED_MESSAGE);
    this.name = "SetupCancelledError";
  }
}

export interface KeytarStore {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

type KeytarGetPassword = (service: string, account: string) => Promise<string | null>;
type KeytarSetPassword = (service: string, account: string, password: string) => Promise<void>;
type KeytarDeletePassword = (service: string, account: string) => Promise<boolean>;

// The schema proves callability only; each wrapper below decodes its live
// result, so the store contract holds even for untyped keytar builds.
const keytarMemberSchema = z.object({
  getPassword: z.custom<KeytarGetPassword>((value) => value instanceof Function),
  setPassword: z.custom<KeytarSetPassword>((value) => value instanceof Function),
  deletePassword: z.custom<KeytarDeletePassword>((value) => value instanceof Function),
});

const keytarModuleSchema = z.union([
  keytarMemberSchema,
  z.object({ default: keytarMemberSchema }),
]);

const credentialsFileSchema = z.object({
  version: z.literal(CREDENTIALS_FILE_VERSION),
  typesafeApiKey: z.string().min(1),
});

const optionalKeySchema = z.string().nullable().optional();

function cleanToken(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// The generic keeps arbitrary module input inside this decoder: the only
// operation on the input is schema validation, and callers receive a
// decoded store or nothing.
export function decodeKeytarModule<T>(candidate: T): KeytarStore | undefined {
  const parsed = keytarModuleSchema.safeParse(candidate);
  if (!parsed.success) return undefined;
  const api = "default" in parsed.data ? parsed.data.default : parsed.data;
  const keySchema = z.string().nullable();
  return {
    async getPassword(service: string, account: string): Promise<string | null> {
      const raw: unknown = await api.getPassword(service, account);
      const checked = keySchema.safeParse(raw);
      return checked.success ? checked.data : null;
    },
    async setPassword(service: string, account: string, password: string): Promise<void> {
      await api.setPassword(service, account, password);
    },
    async deletePassword(service: string, account: string): Promise<boolean> {
      const raw: unknown = await api.deletePassword(service, account);
      return raw === true;
    },
  };
}

async function defaultLoadKeytar(): Promise<KeytarStore | undefined> {
  try {
    await stat(keychainHelperPath());
  } catch {
    return undefined;
  }
  return createChildKeytarStore(spawnHelper);
}

async function defaultReadVarlock(name: string, cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFile("varlock", ["printenv", name], {
      cwd,
      timeout: VARLOCK_TIMEOUT_MS,
    });
    return cleanToken(stdout);
  } catch {
    return undefined;
  }
}

export interface AuthIO {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  xdgConfigHome?: string;
  cwd: string;
  loadKeytar: () => Promise<KeytarStore | undefined>;
  readVarlock: (name: string) => Promise<string | undefined>;
  warn: (message: string) => void;
}

export type KeychainSpawn = (
  args: string[],
  input: string | undefined,
) => Promise<{ stdout: string }>;

export function createChildKeytarStore(
  spawn: KeychainSpawn,
): KeytarStore {
  return {
    async getPassword(service: string, account: string): Promise<string | null> {
      const { stdout } = await spawn(["get", service, account], undefined);
      return stdout.length > 0 ? stdout : null;
    },
    async setPassword(service: string, account: string, password: string): Promise<void> {
      await spawn(["set", service, account], password);
    },
    async deletePassword(service: string, account: string): Promise<boolean> {
      await spawn(["delete", service, account], undefined);
      return true;
    },
  };
}

function keychainHelperPath(): string {
  return fileURLToPath(new URL("./keychain-helper.js", import.meta.url));
}

async function spawnHelper(args: string[], input: string | undefined): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    let helper: string;
    try {
      helper = keychainHelperPath();
    } catch (error) {
      reject(error);
      return;
    }
    const child = spawn(process.execPath, [helper, ...args], {
      timeout: KEYCHAIN_HELPER_TIMEOUT_MS,
    });
    let stdout = "";
    const onChunk = (chunk: StdinChunk): void => {
      stdout += String(chunk);
    };
    child.stdout?.on("data", onChunk);
    child.stderr?.resume();
    if (input !== undefined && child.stdin) {
      child.stdin.write(input);
      child.stdin.end();
    }
    child.on("error", (error: Error) => {
      reject(error);
    });
    child.on("close", (code: number | null) => {
      if (code === 0) resolve({ stdout });
      else reject(new Error("keychain helper exited without success"));
    });
  });
}

export function defaultAuthIO(): AuthIO {
  const io: AuthIO = {
    env: process.env,
    homeDir: homedir(),
    cwd: process.cwd(),
    loadKeytar: defaultLoadKeytar,
    readVarlock: (name: string) => defaultReadVarlock(name, process.cwd()),
    warn: (message: string) => {
      process.stderr.write(`${message}\n`);
    },
  };
  const xdg = cleanToken(process.env.XDG_CONFIG_HOME);
  if (xdg !== undefined) io.xdgConfigHome = xdg;
  return io;
}

export function credentialsFilePath(io: AuthIO): string {
  const base = io.xdgConfigHome ?? join(io.homeDir, ".config");
  return join(base, "jevlint", "credentials");
}

async function readConfigFile(io: AuthIO): Promise<string | undefined> {
  const path = credentialsFilePath(io);
  let contents: string;
  try {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) io.warn(LOOSE_PERMISSIONS_WARNING);
    contents = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(contents);
  } catch {
    return undefined;
  }
  const checked = credentialsFileSchema.safeParse(parsedJson);
  if (!checked.success) return undefined;
  return cleanToken(checked.data.typesafeApiKey);
}

async function readKeychain(io: AuthIO): Promise<string | undefined> {
  try {
    const store = await io.loadKeytar();
    if (store === undefined) return undefined;
    const raw: unknown = await store.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    const checked = optionalKeySchema.safeParse(raw);
    if (!checked.success) return undefined;
    return cleanToken(checked.data ?? undefined);
  } catch {
    return undefined;
  }
}

export async function resolveCredentialWithIO(
  options: ResolveOptions,
  io: AuthIO,
): Promise<ResolvedCredential | undefined> {
  const flag = cleanToken(options.tokenFlag);
  if (flag !== undefined) return { token: flag, source: "flag" };

  const env = cleanToken(io.env[ENV_VAR_NAME]);
  if (env !== undefined) return { token: env, source: "env-jevlint" };

  const sharedEnv = cleanToken(io.env[SHARED_ENV_VAR_NAME]);
  if (sharedEnv !== undefined) return { token: sharedEnv, source: "env-shared" };

  const keychain = await readKeychain(io);
  if (keychain !== undefined) return { token: keychain, source: "keychain" };

  const file = await readConfigFile(io);
  if (file !== undefined) return { token: file, source: "config-file" };

  try {
    const varlock = cleanToken(await io.readVarlock(ENV_VAR_NAME));
    if (varlock !== undefined) return { token: varlock, source: "varlock" };
  } catch {
    return undefined;
  }
  return undefined;
}

const credentialCache = new Map<string | undefined, Promise<ResolvedCredential | undefined>>();

export async function resolveCredential(
  options: ResolveOptions,
): Promise<ResolvedCredential | undefined> {
  const cached = credentialCache.get(options.tokenFlag);
  if (cached !== undefined) return cached;
  const pending = resolveCredentialWithIO(options, defaultAuthIO());
  credentialCache.set(options.tokenFlag, pending);
  try {
    return await pending;
  } catch {
    credentialCache.delete(options.tokenFlag);
    return undefined;
  }
}

export function resetCredentialCache(): void {
  credentialCache.clear();
}

export type StoredBackend = "keychain" | "config-file";

export function storedBackendLabel(backend: StoredBackend): string {
  return backend === "keychain" ? "keychain" : "config file";
}

async function writeConfigFile(token: string, io: AuthIO): Promise<void> {
  const path = credentialsFilePath(io);
  const payload = JSON.stringify({ version: CREDENTIALS_FILE_VERSION, typesafeApiKey: token });
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, `${payload}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not store the API key (${detail.replaceAll(/\s+/g, " ").trim()})`);
  }
}

export async function storeCredential(token: string, io: AuthIO): Promise<StoredBackend> {
  const cleaned = cleanToken(token);
  if (cleaned === undefined) throw new Error("refusing to store an empty API key");
  try {
    const store = await io.loadKeytar();
    if (store !== undefined) {
      await store.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, cleaned);
      return "keychain";
    }
  } catch {
    // Keychain unavailable; fall through to the file backend.
  }
  await writeConfigFile(cleaned, io);
  return "config-file";
}

export async function removeStoredCredential(io: AuthIO): Promise<void> {
  try {
    await unlink(credentialsFilePath(io));
  } catch {
    // Absent file removes cleanly.
  }
  try {
    const store = await io.loadKeytar();
    await store?.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).catch(() => false);
  } catch {
    // Removal is best-effort per backend; the file is already gone.
  }
}

export interface PromptStdin extends NodeJS.ReadableStream {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): void;
}

export type StderrWriter = (text: string) => void;

type StdinChunk = Buffer | string;

function settlePrompt(
  stdin: PromptStdin,
  writeStderr: StderrWriter,
  onData: (chunk: StdinChunk) => void,
  onEnd: () => void,
  onError: (error: Error) => void,
): () => void {
  stdin.on("data", onData);
  stdin.on("end", onEnd);
  stdin.on("error", onError);
  try {
    stdin.setRawMode?.(true);
  } catch {
    // Non-TTY streams may not support raw mode; echo suppression is best-effort.
  }
  stdin.resume();
  return () => {
    stdin.removeListener("data", onData);
    stdin.removeListener("end", onEnd);
    stdin.removeListener("error", onError);
    try {
      stdin.setRawMode?.(false);
    } catch {
      // Ignore teardown failures on synthetic streams.
    }
    try {
      stdin.pause();
    } catch {
      // Ignore teardown failures on synthetic streams.
    }
  };
}

export function promptForApiKey(stdin: PromptStdin, writeStderr: StderrWriter): Promise<string> {
  return new Promise((resolve, reject) => {
    writeStderr(PROMPT_TEXT);
    let buffer = "";
    let settled = false;
    let cleanup = (): void => undefined;
    const finish = (value: string | undefined, error: Error | undefined): void => {
      if (settled) return;
      settled = true;
      cleanup();
      writeStderr("\n");
      if (error !== undefined) reject(error);
      else resolve(value ?? "");
    };
    const cancel = (): void => {
      finish(undefined, new SetupCancelledError());
    };
    const onData = (chunk: StdinChunk): void => {
      const text = String(chunk);
      for (const char of text) {
        if (char === "\u0003") {
          cancel();
          return;
        }
        if (char === "\r" || char === "\n") {
          finish(buffer, undefined);
          return;
        }
        if (char === "\u007f" || char === "\b") {
          buffer = buffer.slice(0, -1);
        } else if (char === "\u0004") {
          if (buffer.length === 0) {
            cancel();
            return;
          }
        } else {
          buffer += char;
        }
      }
    };
    const onEnd = (): void => {
      cancel();
    };
    const onError = (error: Error): void => {
      finish(undefined, error);
    };
    cleanup = settlePrompt(stdin, writeStderr, onData, onEnd, onError);
  });
}

export function readKeyFromStdin(stdin: PromptStdin): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    const onData = (chunk: StdinChunk): void => {
      data += String(chunk);
    };
    const onEnd = (): void => {
      cleanup();
      resolve(data);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = settlePrompt(stdin, () => undefined, onData, onEnd, onError);
    try {
      stdin.setRawMode?.(false);
    } catch {
      // Piped stdin has no raw mode to clear.
    }
  });
}
