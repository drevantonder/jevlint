import { Visitor } from "oxc-parser";
import type { CallExpression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { calleeRootName, resolveModule } from "./repository.js";
import { parseTestFunction } from "./test-scope.js";

export type OwnedModuleMockTarget = {
  specifier: string | null;
  expression: string;
  kind: "owned" | "boundary" | "unknown";
  resolvedFile: string | null;
  adapterHint: boolean;
};

export type MockTargetClassification = {
  kind: OwnedModuleMockTarget["kind"];
  resolvedFile: string | null;
  adapterHint: boolean;
};

export type OwnedModuleMockEvidence = {
  function: {
    title: string | null;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  mocks: OwnedModuleMockTarget[];
  ownedMocks: OwnedModuleMockTarget[];
  boundaryOnly: boolean;
};

const ADAPTER_HINT = /clock|date|fetch|network|http|\bfs\b|file-system|db|database|sql|queue|broker|timer|random|storage|bucket|s3|email|smtp|payment|stripe/i;

function quotedInner(raw: string): string | null {
  const quote = raw[0];
  if (quote !== "\"" && quote !== "'" && quote !== "`") return null;
  if (raw.length < 2 || raw[raw.length - 1] !== quote) return null;
  if (quote === "`" && raw.includes("${")) return null;
  return raw.slice(1, -1);
}

function stringArgument(call: CallExpression, source: string): string | null {
  const first = call.arguments[0];
  if (!first || first.type === "SpreadElement" || first.type !== "Literal") return null;
  return quotedInner(source.slice(first.start, first.end));
}

function isModuleMockCall(call: CallExpression, source: string): boolean {
  const root = calleeRootName(call.callee);
  if (root !== "vi" && root !== "vitest" && root !== "jest") return false;
  return /\.\s*(mock|doMock)\s*\(/.test(source.slice(call.start, call.end));
}

function classifyTarget(
  specifier: string | null,
  fromFile: string,
  projectFiles: ProjectFile[],
): MockTargetClassification {
  if (specifier === null) return { kind: "unknown", resolvedFile: null, adapterHint: false };
  if (!specifier.startsWith(".")) {
    return { kind: "boundary", resolvedFile: null, adapterHint: false };
  }
  const resolved = resolveModule(fromFile, specifier, projectFiles);
  if (!resolved) return { kind: "unknown", resolvedFile: null, adapterHint: false };
  return {
    kind: "owned",
    resolvedFile: resolved.filePath,
    adapterHint: ADAPTER_HINT.test(resolved.filePath),
  };
}

export function buildOwnedModuleMockEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): OwnedModuleMockEvidence | undefined {
  const scope = parseTestFunction(candidate, projectFiles);
  if (!scope) return undefined;
  if (scope.runner !== "it" && scope.runner !== "test") return undefined;
  const { owner, program } = scope;

  const mocks: OwnedModuleMockTarget[] = [];
  const seen = new Set<number>();
  new Visitor({
    CallExpression(call) {
      if (seen.has(call.start)) return;
      if (!isModuleMockCall(call, owner.source)) return;
      seen.add(call.start);
      const specifier = stringArgument(call, owner.source);
      const classified = classifyTarget(specifier, owner.filePath, projectFiles);
      mocks.push({
        specifier,
        expression: owner.source.slice(call.start, call.end).slice(0, 300),
        kind: classified.kind,
        resolvedFile: classified.resolvedFile,
        adapterHint: classified.adapterHint,
      });
    },
  }).visit(program);

  if (mocks.length === 0) return undefined;
  if (mocks.every((mock) => mock.specifier === null)) return undefined;

  mocks.sort((left, right) => (left.specifier ?? "").localeCompare(right.specifier ?? ""));
  const ownedMocks = mocks.filter((mock) => mock.kind === "owned");
  return {
    function: {
      title: scope.title,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    mocks: mocks.slice(0, 15),
    ownedMocks: ownedMocks.slice(0, 15),
    boundaryOnly: ownedMocks.length === 0,
  };
}
