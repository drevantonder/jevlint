// Keychain access runs in this helper child so a wedged secret-service call
// can be killed on timeout. The parent (auth.ts) spawns it per operation and
// treats every failure — missing keytar, hung call, killed child — as an
// absent keychain. Stdout carries a retrieved key and nothing else; the key
// never reaches argv, diagnostics, or dumps.
import { pathToFileURL } from "node:url";
import { decodeKeytarModule } from "./auth.js";
import type { KeytarStore } from "./auth.js";

const KEYTAR_SPECIFIER = "keytar";

export type KeychainHelperResult = {
  exitCode: number;
  output: string;
};

export type KeychainLoader = () => Promise<KeytarStore | undefined>;

async function loadRealStore(): Promise<KeytarStore | undefined> {
  try {
    const candidate: unknown = await import(KEYTAR_SPECIFIER);
    return decodeKeytarModule(candidate);
  } catch {
    return undefined;
  }
}

async function readStdinText(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) {
    data += String(chunk);
  }
  return data;
}

function isHelperOp(value: string | undefined): value is "get" | "set" | "delete" {
  return value === "get" || value === "set" || value === "delete";
}

export async function runKeychainHelper(
  argv: string[],
  stdinText: string,
  load: KeychainLoader = loadRealStore,
): Promise<KeychainHelperResult> {
  const [op, service, account] = argv;
  if (!isHelperOp(op) || service === undefined || account === undefined) {
    return { exitCode: 1, output: "" };
  }
  const store = await load();
  if (store === undefined) return { exitCode: 1, output: "" };
  try {
    if (op === "get") {
      const value = await store.getPassword(service, account);
      return { exitCode: 0, output: value ?? "" };
    }
    if (op === "set") {
      await store.setPassword(service, account, stdinText);
      return { exitCode: 0, output: "" };
    }
    await store.deletePassword(service, account);
    return { exitCode: 0, output: "" };
  } catch {
    return { exitCode: 1, output: "" };
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  const stdinText = process.argv[2] === "set" ? await readStdinText() : "";
  const result = await runKeychainHelper(process.argv.slice(2), stdinText);
  if (result.output.length > 0) process.stdout.write(result.output);
  process.exit(result.exitCode);
}
