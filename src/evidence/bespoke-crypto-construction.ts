import { parseSync, Visitor } from "oxc-parser";
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

export type BitwiseOperation = {
  operator: string;
  excerpt: string;
  line: number;
};

export type BespokeCryptoEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  bitwiseOperations: BitwiseOperation[];
  byteLoop: string | null;
  vettedImports: string[];
  namedPrimitiveCalls: string[];
  securityBearingCallers: FunctionCaller[];
  callers: FunctionCaller[];
};

const CRYPTO_NAME_PATTERN = /encrypt|decrypt|encipher|decipher|cipher|hash|digest|sign|token|obfuscat|encode.?secret|scramble/i;
const VETTED_IMPORT_PATTERN = /^(node:)?crypto$|^jose$|bcrypt|argon2|sodium|tweetnacl|pbkdf2|hkdf|scrypt/i;
const NAMED_PRIMITIVE_PATTERN = /createHash|createHmac|createCipher|subtle\s*\.\s*digest|\.digest\s*\(|randomUUID|getRandomValues|randomBytes/i;
const SECURITY_BEARING_PATTERN = /stor|compar|transmit|send|verif|password|secret|credential|auth/i;
const BYTE_LOOP_PATTERN = /charCodeAt|fromCharCode|TextEncoder|Uint8Array|Buffer\s*\.\s*from/i;

const BITWISE_OPERATORS = new Set(["^", "<<", ">>", ">>>", "|", "&"]);

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function calleeText(call: CallExpression, source: string): string {
  return source.slice(call.callee.start, call.callee.end);
}

export function buildBespokeCryptoConstructionEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): BespokeCryptoEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  if (!CRYPTO_NAME_PATTERN.test(name)) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const bitwiseOperations: BitwiseOperation[] = [];
  const namedPrimitiveCalls: string[] = [];
  new Visitor({
    BinaryExpression(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      if (!BITWISE_OPERATORS.has(node.operator)) return;
      bitwiseOperations.push({
        operator: node.operator,
        excerpt: owner.source.slice(node.start, node.end).slice(0, 200),
        line: lineAt(owner.source, node.start),
      });
    },
    CallExpression(call) {
      if (call.start < candidate.start || call.end > candidate.end) return;
      if (!belongsDirectlyToFunction(call, nested)) return;
      const callee = calleeText(call, owner.source);
      if (NAMED_PRIMITIVE_PATTERN.test(callee)) {
        namedPrimitiveCalls.push(owner.source.slice(call.start, call.end).slice(0, 200));
      }
    },
  }).visit(parsed.program);

  if (bitwiseOperations.length === 0) return undefined;
  if (namedPrimitiveCalls.length > 0) return undefined;

  const byteLoopMatch = BYTE_LOOP_PATTERN.exec(candidate.source);
  const vettedImports = moduleImports(parsed.program)
    .map(({ source }) => source)
    .filter((source, index, all) => all.indexOf(source) === index)
    .filter((source) => VETTED_IMPORT_PATTERN.test(source))
    .slice(0, 10);

  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);
  const securityBearingCallers = callers
    .filter(({ call }) => SECURITY_BEARING_PATTERN.test(call))
    .slice(0, 10);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    bitwiseOperations: bitwiseOperations.slice(0, 10),
    byteLoop: byteLoopMatch ? byteLoopMatch[0].slice(0, 60) : null,
    vettedImports,
    namedPrimitiveCalls,
    securityBearingCallers,
    callers,
  };
}
