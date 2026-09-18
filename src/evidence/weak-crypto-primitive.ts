import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

const MAX_CALLS = 10;

const WEAK_ALGORITHMS = new Set(["md5", "sha1", "sha-1", "des", "desx", "rc2", "rc4"]);
const ECB_MODE_PATTERN = /\becb\b/i;
const STRONG_PRIMITIVE_PATTERN = /sha256|sha-384|sha-512|sha384|sha512|bcrypt|scrypt|argon2|hkdf|pbkdf2|aes-256-gcm|chacha20/i;
const FALLBACK_IMPORT_PATTERN = /^(md5|sha1|js-sha1|js-md5|blueimp-md5)|crypto-js\/(md5|sha1)$/i;

const CREDENTIAL_POSITION_PATTERN = /password|secret|token|stored|credential|verify|compare|authenticate/i;
const CHECKSUM_POSITION_PATTERN = /cache|etag|checksum|fingerprint|dedup|content-hash|key/i;
const COMPARISON_PATTERN = /===|!==|==|!=/;

export type CryptoCallPosition = "hash" | "hmac" | "cipher" | "digest" | "fallback-import";

export type WeakCryptoCall = {
  call: string;
  callee: string;
  algorithm: string;
  position: CryptoCallPosition;
  line: number;
  guardPosition: "credential-comparison" | "checksum-cache" | "unclear";
  comparedAgainstStored: boolean;
};

export type WeakCryptoPrimitiveEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  weakCalls: WeakCryptoCall[];
  cryptoImports: string[];
  strongerPrimitiveNearby: boolean;
  callers: FunctionCaller[];
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function stringArgument(call: CallExpression, source: string): string | undefined {
  const first = call.arguments[0];
  if (!first || first.type === "SpreadElement") return undefined;
  const raw = source.slice(first.start, first.end).trim();
  const quote = raw[0];
  if (quote !== "\"" && quote !== "'") return undefined;
  if (raw.length < 2 || raw[raw.length - 1] !== quote) return undefined;
  return raw.slice(1, -1).toLowerCase();
}

function calleeText(call: CallExpression, source: string): string {
  return source.slice(call.callee.start, call.callee.end);
}

function isWeakAlgorithm(algorithm: string): boolean {
  return WEAK_ALGORITHMS.has(algorithm) || ECB_MODE_PATTERN.test(algorithm);
}

function classifyPosition(callee: string): CryptoCallPosition | undefined {
  const normalized = callee.toLowerCase();
  if (normalized.endsWith("createhmac") || normalized.includes(".createhmac")) return "hmac";
  if (normalized.endsWith("createhash") || normalized.includes(".createhash")) return "hash";
  if (normalized.endsWith("createcipher") || normalized.endsWith("createcipheriv")
    || normalized.includes(".createcipher")) return "cipher";
  if (normalized.includes("subtle") && normalized.endsWith("digest")) return "digest";
  if (normalized === "digest") return "digest";
  return undefined;
}

export function buildWeakCryptoPrimitiveEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): WeakCryptoPrimitiveEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const weakCalls: WeakCryptoCall[] = [];
  new Visitor({
    CallExpression(call) {
      if (weakCalls.length >= MAX_CALLS) return;
      if (call.start < candidate.start || call.end > candidate.end) return;
      if (!belongsDirectlyToFunction(call, nested)) return;
      const callee = calleeText(call, owner.source);
      const position = classifyPosition(callee);
      if (!position) return;
      const algorithm = stringArgument(call, owner.source);
      if (!algorithm || !isWeakAlgorithm(algorithm)) return;
      const statement = owner.source.slice(
        owner.source.lastIndexOf("\n", call.start) + 1,
        owner.source.indexOf("\n", call.end) === -1
          ? owner.source.length
          : owner.source.indexOf("\n", call.end),
      );
      const positionText = `${statement} ${name}`;
      const guardsCredential = CREDENTIAL_POSITION_PATTERN.test(positionText);
      const servesChecksum = CHECKSUM_POSITION_PATTERN.test(positionText);
      weakCalls.push({
        call: owner.source.slice(call.start, call.end).slice(0, 200),
        callee,
        algorithm,
        position,
        line: lineAt(owner.source, call.start),
        guardPosition: guardsCredential
          ? "credential-comparison"
          : servesChecksum
            ? "checksum-cache"
            : "unclear",
        comparedAgainstStored: COMPARISON_PATTERN.test(candidate.source),
      });
    },
  }).visit(parsed.program);

  const cryptoImports = moduleImports(parsed.program)
    .map(({ source }) => source)
    .filter((source, index, all) => all.indexOf(source) === index)
    .filter((source) => /crypto|md5|sha1/i.test(source))
    .slice(0, 10);
  const fallbackImports = moduleImports(parsed.program)
    .filter(({ source }) => FALLBACK_IMPORT_PATTERN.test(source));
  for (const fallback of fallbackImports) {
    if (weakCalls.length >= MAX_CALLS) break;
    weakCalls.push({
      call: `import from ${JSON.stringify(fallback.source)}`,
      callee: fallback.local,
      algorithm: fallback.source,
      position: "fallback-import",
      line: 1,
      guardPosition: "unclear",
      comparedAgainstStored: false,
    });
  }
  if (weakCalls.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    weakCalls,
    cryptoImports,
    strongerPrimitiveNearby: STRONG_PRIMITIVE_PATTERN.test(owner.source),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
