import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export const ENV_VAR_NAME = "TYPESAFE_API_KEY";
export const SHELL_RC_FILES = [".bashrc", ".zshrc"] as const;
export const SHELL_MARKER = "# jevlint";

export type CredentialSource = "env";

export interface ResolvedCredential {
  token: string;
  source: CredentialSource;
}

export const MISSING_CREDENTIAL_MESSAGE =
  `jevlint: no Typesafe API key found. Set ${ENV_VAR_NAME} or run 'jevlint setup'.`;

export function authRejectionMessage(source: string): string {
  return `Typesafe rejected the API key (${source}). Set ${ENV_VAR_NAME} to a new key or run 'jevlint setup'.`;
}

export const SETUP_CANCELLED_MESSAGE = "jevlint: setup cancelled";
export const STORED_REMOVED_MESSAGE = "jevlint: stored credential removed";
export const SETUP_NON_TTY_MESSAGE = "jevlint: setup needs an interactive terminal to read the key.";
export const PROMPT_TEXT = "Enter your Typesafe (Jev) API key: ";

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

function cleanToken(value: string | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export interface AuthIO {
  env: NodeJS.ProcessEnv;
  homeDir: string;
}

export function defaultAuthIO(): AuthIO {
  return { env: process.env, homeDir: homedir() };
}

export function resolveCredentialWithIO(io: AuthIO): ResolvedCredential | undefined {
  const token = cleanToken(io.env[ENV_VAR_NAME]);
  if (token === undefined) return undefined;
  return { token, source: "env" };
}

export function resolveCredential(): ResolvedCredential | undefined {
  return resolveCredentialWithIO(defaultAuthIO());
}

export function shellExportLine(token: string): string {
  const escaped = token.replaceAll("'", "'\\''");
  return `export ${ENV_VAR_NAME}='${escaped}' ${SHELL_MARKER}`;
}

function shellRcPath(homeDir: string, file: string): string {
  return join(homeDir, file);
}

interface StrippedShellFile {
  stripped: string;
  removed: boolean;
}

function stripManagedLines(contents: string): StrippedShellFile {
  const lines = contents.split("\n");
  const kept = lines.filter((line) => !line.includes(SHELL_MARKER));
  const removed = kept.length !== lines.length;
  return { stripped: kept.join("\n"), removed };
}

function backupPath(path: string): string {
  return join(dirname(path), `${basename(path)}.jevlint.bak`);
}

export interface ShellWriteResult {
  path: string;
  display: string;
  created: boolean;
  backup: string | undefined;
}

async function readExisting(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function installShellKey(token: string, io: AuthIO): Promise<ShellWriteResult[]> {
  const cleaned = cleanToken(token);
  if (cleaned === undefined) throw new Error("refusing to store an empty API key");
  const line = shellExportLine(cleaned);
  const results: ShellWriteResult[] = [];
  for (const file of SHELL_RC_FILES) {
    const path = shellRcPath(io.homeDir, file);
    const display = `~/${file}`;
    const existing = await readExisting(path);
    let backup: string | undefined;
    if (existing !== undefined) {
      backup = backupPath(path);
      await copyFile(path, backup);
    } else {
      await mkdir(io.homeDir, { recursive: true });
    }
    const { stripped } = stripManagedLines(existing ?? "");
    const withoutTrailing = stripped.replace(/\n+$/, "");
    const contents = withoutTrailing.length > 0 ? `${withoutTrailing}\n${line}\n` : `${line}\n`;
    if (existing === undefined) {
      await writeFile(path, contents, { mode: 0o600 });
    } else {
      await writeFile(path, contents);
    }
    results.push({ path, display, created: existing === undefined, backup });
  }
  return results;
}

export async function removeShellKey(io: AuthIO): Promise<string[]> {
  const changed: string[] = [];
  for (const file of SHELL_RC_FILES) {
    const path = shellRcPath(io.homeDir, file);
    const existing = await readExisting(path);
    if (existing === undefined) continue;
    const { stripped, removed } = stripManagedLines(existing);
    if (!removed) continue;
    await copyFile(path, backupPath(path));
    await writeFile(path, stripped);
    changed.push(`~/${file}`);
  }
  return changed;
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
