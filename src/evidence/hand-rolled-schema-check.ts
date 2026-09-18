import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, nestedFunctionRanges } from "./function-scope.js";
import { manifestFacts } from "./manifest-facts.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type SchemaCheckSignal = {
  signal: string;
  excerpt: string;
};

export type HandRolledSchemaCheckEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  ownedValidator: string;
  siblingImporters: string[];
  lockfilePresent: boolean;
  signals: SchemaCheckSignal[];
  typeofCheckCount: number;
  callers: FunctionCaller[];
};

const SCHEMA_DEPS = ["zod", "ajv", "valibot", "yup", "joi"];

const REQUIRED_LOOP_PATTERN = /\bfor\s*\(\s*(?:const|let|var)\s+\w+\s+of\b|\bObject\s*\.\s*(?:keys|entries)\s*\(/;
const ERROR_ACCUMULATION_PATTERN = /\berrors\s*\.\s*push\s*\(|\bissues\s*\.\s*push\s*\(|\bthrow\s+new\s+Error\s*\(/;
const CUSTOM_ERROR_CODE_PATTERN = /\bcode\s*:\s*['"][A-Z_]+['"]|\berrorCode\s*:/;

export function buildHandRolledSchemaCheckEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HandRolledSchemaCheckEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const facts = manifestFacts(projectFiles, candidate.filePath, SCHEMA_DEPS);
  if (!facts.matchedDep) return undefined;
  if (facts.candidateImportsDep) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const typeofChecks: string[] = [];
  new Visitor({
    BinaryExpression(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      if (node.operator !== "!==" && node.operator !== "===") return;
      const text = owner.source.slice(node.start, node.end);
      if (!/\btypeof\b/.test(text)) return;
      typeofChecks.push(text.slice(0, 200));
    },
  }).visit(parsed.program);

  const signals: SchemaCheckSignal[] = [];
  for (const excerpt of typeofChecks.slice(0, 10)) {
    signals.push({ signal: "typeof-check", excerpt });
  }
  const requiredLoop = REQUIRED_LOOP_PATTERN.exec(candidate.source);
  if (requiredLoop) signals.push({ signal: "required-field-loop", excerpt: requiredLoop[0].slice(0, 200) });
  const errorAccumulation = ERROR_ACCUMULATION_PATTERN.exec(candidate.source);
  if (errorAccumulation) {
    signals.push({ signal: "error-accumulation", excerpt: errorAccumulation[0].slice(0, 200) });
  }

  const multiField = typeofChecks.length >= 2 || (requiredLoop !== null && errorAccumulation !== null);
  if (!multiField) return undefined;

  const customErrorCode = CUSTOM_ERROR_CODE_PATTERN.exec(candidate.source);
  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    ownedValidator: facts.matchedDep,
    siblingImporters: facts.siblingImporters,
    lockfilePresent: facts.lockfilePresent,
    signals: [
      ...signals,
      ...(customErrorCode
        ? [{ signal: "custom-error-code", excerpt: customErrorCode[0].slice(0, 200) }]
        : []),
    ],
    typeofCheckCount: typeofChecks.length,
    callers,
  };
}
