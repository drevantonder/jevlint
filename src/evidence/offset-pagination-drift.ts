import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type OffsetPaginationDriftEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  paginationParams: string[];
  hasStableOrdering: boolean;
  unusedCursorParam: string | null;
  siblingCursorPagination: boolean;
  writerCallers: FunctionCaller[];
  callers: FunctionCaller[];
};

const OFFSET_PARAMS = new Set(["offset", "skip", "page", "pageNumber", "page_number"]);
const LIMIT_PARAMS = new Set(["limit", "take", "perPage", "per_page", "pageSize", "page_size", "first"]);
const CURSOR_PARAMS = new Set(["cursor", "after", "pageToken", "page_token", "starting_after", "startAfter"]);

const WRITE_TOKEN = /insert|create|update|delete|save|remove|upsert|publish/i;

function parameterNames(fn: FunctionNode): string[] {
  const result: string[] = [];
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    if (value.type === "Identifier") result.push(value.name);
    else if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
      result.push(value.left.name);
    } else if (value.type === "ObjectPattern") {
      for (const property of value.properties) {
        if (property.type === "Property" && property.key.type === "Identifier") result.push(property.key.name);
      }
    }
  }
  return result;
}

export function buildOffsetPaginationDriftEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): OffsetPaginationDriftEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const params = parameterNames(fn);
  const paginationParams = params.filter((param) => OFFSET_PARAMS.has(param) || LIMIT_PARAMS.has(param));
  if (paginationParams.length === 0) return undefined;

  const body = owner.source.slice(fn.start, fn.end);
  const hasStableOrdering = /orderBy|order_by|ORDER\s+BY|cursor|unique|createdAt|created_at/.test(body);

  let unusedCursorParam: string | null = null;
  for (const param of params) {
    if (!CURSOR_PARAMS.has(param)) continue;
    const occurrences = body.match(new RegExp(`\\b${param}\\b`, "g")) ?? [];
    if (occurrences.length <= 1) {
      unusedCursorParam = param;
      break;
    }
  }

  let siblingCursorPagination = false;
  for (const file of projectFiles) {
    if (file.filePath === owner.filePath) continue;
    if (/starting_after|pageToken|cursor.*orderBy|orderBy.*cursor|keyset/i.test(file.source)) {
      siblingCursorPagination = true;
      break;
    }
  }

  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);
  const writerCallers = callers.filter((caller) => WRITE_TOKEN.test(caller.call)).slice(0, 10);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    paginationParams,
    hasStableOrdering,
    unusedCursorParam,
    siblingCursorPagination,
    writerCallers,
    callers,
  };
}
