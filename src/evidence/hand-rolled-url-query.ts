import { parseSync, Visitor } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type HandRolledUrlQueryEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  parseSignals: string[];
  buildSignals: string[];
  nestedSyntaxSupport: boolean;
  usesUrlSearchParams: boolean;
  urlSearchParamsShelf: string[];
  nestedSyntaxCallers: string[];
  callers: FunctionCaller[];
};

const BRACKET_SYNTAX_PATTERN = /\[.*\]/;

function urlSearchParamsShelf(projectFiles: ProjectFile[], ownerPath: string): string[] {
  const result: string[] = [];
  for (const file of projectFiles) {
    if (file.filePath === ownerPath) continue;
    if (file.source.includes("URLSearchParams")) {
      result.push(file.filePath);
      if (result.length >= 8) break;
    }
  }
  return result;
}

export function buildHandRolledUrlQueryEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HandRolledUrlQueryEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const parseSignals: string[] = [];
  const buildSignals: string[] = [];
  const stringLiterals: string[] = [];

  new Visitor({
    Literal(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      stringLiterals.push(owner.source.slice(node.start, node.end));
    },
    TemplateLiteral(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (!belongsDirectlyToFunction(node, nested)) return;
      stringLiterals.push(owner.source.slice(node.start, node.end));
    },
    CallExpression(call) {
      if (call.start < candidate.start || call.end > candidate.end) return;
      if (!belongsDirectlyToFunction(call, nested)) return;
      const callee = owner.source.slice(call.callee.start, call.callee.end);
      const first = call.arguments[0];
      const firstText = first ? owner.source.slice(first.start, first.end) : "";
      if (
        (callee.endsWith(".split") || callee === "split")
        && (/^(['"`])[&=]\1$/.test(firstText.trim()))
      ) {
        parseSignals.push(owner.source.slice(call.start, call.end).slice(0, 200));
      }
      if (
        (callee.endsWith(".join") || callee === "join")
        && (/^(['"`])&\1$/.test(firstText.trim()))
      ) {
        buildSignals.push(owner.source.slice(call.start, call.end).slice(0, 200));
      }
      if (/encodeURIComponent|decodeURIComponent/.test(callee)) {
        buildSignals.push(owner.source.slice(call.start, call.end).slice(0, 200));
      }
    },
  }).visit(parsed.program);

  const hasSplitParse = parseSignals.length > 0;
  const hasCodecBuild = buildSignals.some((signal) => /encodeURIComponent|decodeURIComponent/.test(signal))
    && buildSignals.some((signal) => /\.join\(/.test(signal));
  const hasCodecJoinParse = parseSignals.length > 0
    && buildSignals.some((signal) => /encodeURIComponent|decodeURIComponent/.test(signal));
  if (!hasSplitParse && !hasCodecBuild && !hasCodecJoinParse) return undefined;

  const nestedSyntaxSupport = stringLiterals.some((literal) =>
    BRACKET_SYNTAX_PATTERN.test(literal)
  );
  const nestedSyntaxCallers: string[] = [];
  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);
  for (const caller of callers) {
    if (/test|spec|snapshot/i.test(caller.filePath)) {
      nestedSyntaxCallers.push(`test-positioned caller: ${caller.filePath}`);
    }
    if (/%5B|%5D/i.test(caller.call)) {
      nestedSyntaxCallers.push(`bracket syntax at caller: ${caller.call.slice(0, 120)}`);
    }
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    parseSignals: parseSignals.slice(0, 8),
    buildSignals: buildSignals.slice(0, 8),
    nestedSyntaxSupport,
    usesUrlSearchParams: candidate.source.includes("URLSearchParams"),
    urlSearchParamsShelf: urlSearchParamsShelf(projectFiles, candidate.filePath),
    nestedSyntaxCallers: [...new Set(nestedSyntaxCallers)].slice(0, 8),
    callers,
  };
}
