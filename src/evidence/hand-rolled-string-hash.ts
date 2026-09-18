import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
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

export type HandRolledStringHashEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  algorithmFamily: "djb2" | "fnv" | "bitwise-fold";
  foldOperations: string[];
  seedable: boolean;
  benchmarkNote: boolean;
  nodeCryptoInScope: boolean;
  testPinning: string[];
  callers: FunctionCaller[];
};

const HASH_NAME_PATTERN = /hash|digest|checksum|fingerprint|bucket|shard/i;
const SECURITY_NAME_PATTERN = /password|secret|credential|auth|token|session|sign|hmac|encrypt|decrypt|salt/i;
const SECURITY_CALLER_PATTERN = /password|secret|credential|auth|compar|stor|verif|sign/i;
const BITWISE_OPERATORS = new Set(["^", "<<", ">>", ">>>", "|"]);
const DJB2_PATTERN = /\*\s*33|<<\s*5/;
const FNV_PATTERN = /16777619|2166136261|0x811c|0x01000193/i;
const LOOP_PATTERN = /\bfor\s*\(|\bwhile\s*\(/;
const CHAR_CODE_PATTERN = /charCodeAt/;
const SEED_PATTERN = /\bseed\b/i;
const BENCHMARK_PATTERN = /benchmark|perf\b|hot[\s-]path|\bfast\b/i;
const NODE_CRYPTO_PATTERN = /node:crypto|^crypto$/;

export function buildHandRolledStringHashEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HandRolledStringHashEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  if (!HASH_NAME_PATTERN.test(name)) return undefined;

  // Strength choice in a security position belongs to
  // jev/no-weak-crypto-primitive; this rule scores gratuitous
  // reimplementation for non-security bucketing.
  if (SECURITY_NAME_PATTERN.test(name)) return undefined;

  if (!LOOP_PATTERN.test(candidate.source)) return undefined;
  if (!CHAR_CODE_PATTERN.test(candidate.source)) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const foldOperations: string[] = [];
  new Visitor({
    BinaryExpression(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      if (!BITWISE_OPERATORS.has(node.operator)) return;
      foldOperations.push(node.operator);
    },
  }).visit(parsed.program);
  if (foldOperations.length === 0) return undefined;

  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);
  if (callers.some(({ call }) => SECURITY_CALLER_PATTERN.test(call))) return undefined;

  const algorithmFamily = FNV_PATTERN.test(candidate.source)
    ? "fnv"
    : DJB2_PATTERN.test(candidate.source)
      ? "djb2"
      : "bitwise-fold";

  const nodeCryptoInScope = moduleImports(parsed.program)
    .some(({ source }) => NODE_CRYPTO_PATTERN.test(source))
    || /crypto\.(createHash|randomBytes|subtle)/.test(owner.source);

  const testPinning = callers
    .map(({ filePath }) => filePath)
    .filter((filePath, index, all) => all.indexOf(filePath) === index)
    .filter((filePath) => /\.test\.|\/fixtures\//.test(filePath))
    .slice(0, 10);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    algorithmFamily,
    foldOperations: [...new Set(foldOperations)],
    seedable: SEED_PATTERN.test(candidate.source),
    benchmarkNote: BENCHMARK_PATTERN.test(candidate.source),
    nodeCryptoInScope,
    testPinning,
    callers,
  };
}
