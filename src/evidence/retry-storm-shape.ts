import { parseSync, Visitor } from "oxc-parser";
import type {
  CallExpression,
  DoWhileStatement,
  Expression,
  ForStatement,
  Node,
  Program,
  WhileStatement,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, containsNode, nestedFunctionRanges } from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller, RelatedProjectModule } from "./repository.js";

type RetryLoop = ForStatement | WhileStatement | DoWhileStatement;

type Timing = "backoff" | "fixed-delay" | "none";

export type SiblingRetrySite = {
  filePath: string;
  function: string | null;
  call: string;
  retrySource: string;
  timing: Timing;
  hasAttemptBudget: boolean;
};

export type RetryStormEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  ownRetry: {
    source: string;
    timing: Timing;
    hasAttemptBudget: boolean;
  };
  sharedDependency: {
    name: string;
    importedFrom: string | null;
    ownership: "same-module" | "project-module" | "external-package" | "global" | "unresolved";
    targetModule: { filePath: string; source: string } | null;
  };
  siblingRetrySites: SiblingRetrySite[];
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    return expression.object.type === "Super" ? undefined : rootIdentifier(expression.object);
  }
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  if (
    expression.type === "TSAsExpression"
    || expression.type === "TSNonNullExpression"
    || expression.type === "TSSatisfiesExpression"
    || expression.type === "TSTypeAssertion"
  ) return rootIdentifier(expression.expression);
  return undefined;
}

function finalCalleeName(callee: CallExpression["callee"]): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression") {
    if (callee.property.type === "Identifier") return callee.property.name;
    if (callee.property.type === "Literal") return String(callee.property.value);
  }
  return null;
}

function isDelayCall(call: CallExpression): boolean {
  const name = finalCalleeName(call.callee);
  return name !== null && /^(?:sleep|delay|wait|backoff|setTimeout)$/i.test(name);
}

function timingOf(range: NodeRange, program: Program, nested: NodeRange[]): Timing {
  let delay = false;
  let spread = false;
  new Visitor({
    CallExpression(call) {
      if (!containsNode(range, call) || !belongsDirectlyToFunction(call, nested)) return;
      if (isDelayCall(call)) delay = true;
    },
    Identifier(node) {
      if (!containsNode(range, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (/backoff|jitter|exponential|random/i.test(node.name)) spread = true;
    },
  }).visit(program);
  if (spread) return "backoff";
  return delay ? "fixed-delay" : "none";
}

function hasAttemptBudget(range: NodeRange, program: Program, nested: NodeRange[]): boolean {
  let budget = false;
  new Visitor({
    Identifier(node) {
      if (!containsNode(range, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (/maxAttempts|maxRetries|attemptBudget|retryBudget|attempts/i.test(node.name)) budget = true;
    },
  }).visit(program);
  return budget;
}

function loopHasCatch(loop: RetryLoop, program: Program): boolean {
  let found = false;
  new Visitor({
    CatchClause(handler) {
      if (containsNode(loop, handler)) found = true;
    },
  }).visit(program);
  return found;
}

function callsWithin(
  range: NodeRange,
  program: Program,
  nested: NodeRange[],
): CallExpression[] {
  const calls: CallExpression[] = [];
  new Visitor({
    CallExpression(call) {
      if (containsNode(range, call) && belongsDirectlyToFunction(call, nested)) calls.push(call);
    },
  }).visit(program);
  return calls;
}

type RetrySite = {
  range: NodeRange;
  source: string;
};

function retrySitesIn(
  fn: NodeRange,
  program: Program,
  source: string,
  nested: NodeRange[],
): RetrySite[] {
  const sites: RetrySite[] = [];
  const loops: RetryLoop[] = [];
  const addLoop = (loop: RetryLoop): void => {
    if (containsNode(fn, loop) && belongsDirectlyToFunction(loop, nested)) loops.push(loop);
  };
  new Visitor({
    DoWhileStatement: addLoop,
    ForStatement: addLoop,
    WhileStatement: addLoop,
  }).visit(program);
  for (const loop of loops) {
    if (loopHasCatch(loop, program)) {
      sites.push({ range: loop, source: nodeSource(loop, source) });
    }
  }
  new Visitor({
    CallExpression(call) {
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested)) return;
      if (loops.some((loop) => containsNode(loop, call))) return;
      const name = finalCalleeName(call.callee);
      if (name !== null && /retry/i.test(name)) {
        sites.push({ range: call, source: nodeSource(call, source) });
      }
    },
    CatchClause(handler) {
      if (!containsNode(fn, handler) || !belongsDirectlyToFunction(handler, nested)) return;
      if (loops.some((loop) => containsNode(loop, handler))) return;
      for (const call of callsWithin(handler.body, program, nested)) {
        sites.push({ range: handler, source: nodeSource(handler, source) });
        void call;
        break;
      }
    },
  }).visit(program);
  return sites;
}

function enclosingFunctionName(program: Program, offset: number): string | null {
  let name: string | null = null;
  let smallest = Number.POSITIVE_INFINITY;
  const consider = (start: number, end: number, candidate: string | undefined): void => {
    if (start <= offset && offset <= end && end - start < smallest && candidate) {
      smallest = end - start;
      name = candidate;
    }
  };
  new Visitor({
    FunctionDeclaration(node) {
      consider(node.start, node.end, node.id?.name);
    },
    VariableDeclarator(node) {
      if (
        node.id.type === "Identifier"
        && node.init
        && (node.init.type === "ArrowFunctionExpression" || node.init.type === "FunctionExpression")
        && node.init.start <= offset
        && offset <= node.init.end
      ) consider(node.init.start, node.init.end, node.id.name);
    },
  }).visit(program);
  return name;
}

export function buildRetryStormEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): RetryStormEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseSync(ownerFile.filePath, ownerFile.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const ownSites = retrySitesIn(fn, parsed.program, ownerFile.source, nested);
  if (ownSites.length === 0) return undefined;
  const ownSite = ownSites[0];
  if (!ownSite) return undefined;

  const imports = moduleImports(parsed.program);
  const ownCalls = callsWithin(ownSite.range, parsed.program, nested);
  const retriedRoots = new Map<string, string | undefined>();
  for (const call of ownCalls) {
    if (isDelayCall(call)) continue;
    const root = rootIdentifier(call.callee);
    if (!root || /retry/i.test(root)) continue;
    if (!retriedRoots.has(root)) {
      retriedRoots.set(root, imports.find(({ local }) => local === root)?.source);
    }
  }
  if (retriedRoots.size === 0) return undefined;

  const siblingSites: SiblingRetrySite[] = [];
  let shared: { name: string; importedFrom: string | undefined } | undefined;
  for (const [root, importSource] of retriedRoots) {
    for (const file of projectFiles) {
      const fileParsed = parseSync(file.filePath, file.source, { range: true });
      if (fileParsed.errors.some((error) => error.severity === "Error")) continue;
      const fileImports = moduleImports(fileParsed.program);
      const fileImportSource = file.filePath === ownerFile.filePath
        ? importSource
        : fileImports.find(({ local }) => local === root)?.source;
      if (file.filePath !== ownerFile.filePath && fileImportSource === undefined && root !== "fetch") {
        continue;
      }
      if (
        file.filePath !== ownerFile.filePath
        && importSource !== undefined
        && fileImportSource !== importSource
        && root !== "fetch"
      ) continue;
      const outer: NodeRange = { start: 0, end: file.source.length };
      const sites = retrySitesIn(outer, fileParsed.program, file.source, []);
      for (const site of sites) {
        if (file.filePath === ownerFile.filePath && containsNode(fn, site.range)) continue;
        const siteCalls = callsWithin(site.range, fileParsed.program, []);
        const hits = siteCalls.filter((call) => {
          if (isDelayCall(call)) return false;
          return rootIdentifier(call.callee) === root;
        });
        if (hits.length === 0) continue;
        if (!shared) shared = { name: root, importedFrom: fileImportSource ?? importSource };
        siblingSites.push({
          filePath: file.filePath,
          function: enclosingFunctionName(fileParsed.program, site.range.start),
          call: file.source.slice(hits[0]?.start ?? site.range.start, hits[0]?.end ?? site.range.end),
          retrySource: site.source,
          timing: timingOf(site.range, fileParsed.program, []),
          hasAttemptBudget: hasAttemptBudget(site.range, fileParsed.program, []),
        });
      }
    }
    if (siblingSites.length > 0) break;
  }
  if (!shared || siblingSites.length === 0) return undefined;

  const targetFile = shared.importedFrom
    ? resolveModule(ownerFile.filePath, shared.importedFrom, projectFiles)
    : undefined;
  const ownership = shared.name === "fetch" && !shared.importedFrom
    ? "global"
    : shared.importedFrom
      ? shared.importedFrom.startsWith(".") ? "project-module" : "external-package"
      : targetFile
        ? "same-module"
        : "unresolved";

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    ownRetry: {
      source: ownSite.source,
      timing: timingOf(ownSite.range, parsed.program, nested),
      hasAttemptBudget: hasAttemptBudget(ownSite.range, parsed.program, nested),
    },
    sharedDependency: {
      name: shared.name,
      importedFrom: shared.importedFrom ?? null,
      ownership,
      targetModule: targetFile
        ? { filePath: targetFile.filePath, source: targetFile.source.slice(0, 12_000) }
        : null,
    },
    siblingRetrySites: siblingSites.slice(0, 12),
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(candidate.filePath, parsed.program, projectFiles),
    },
  };
}
