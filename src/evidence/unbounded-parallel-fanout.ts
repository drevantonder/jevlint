import { parseSync, Visitor } from "oxc-parser";
import type { CallExpression, Expression, Node } from "oxc-parser";
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
} from "./repository.js";
import type { FunctionCaller, RelatedProjectModule } from "./repository.js";

export type FanoutProvenance = "parameter" | "request" | "closed-constant" | "unknown";

export type ParallelFanout = {
  source: string;
  combinator: string;
  collection: string;
  collectionProvenance: FanoutProvenance;
  legSource: string;
  heavyLeg: boolean;
};

export type UnboundedParallelFanoutEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  fanouts: ParallelFanout[];
  limiter: {
    present: boolean;
    imports: string[];
  };
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

const LIMITER = /p-limit|p-map|p-queue|p-throttle|bottleneck|semaphore|pool|throttle|concurrency/i;
const COMBINATORS = new Set(["all", "allSettled", "race", "any"]);

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function isPromiseCombinator(call: CallExpression): string | undefined {
  if (
    call.callee.type === "MemberExpression"
    && call.callee.object.type === "Identifier"
    && call.callee.object.name === "Promise"
    && call.callee.property.type === "Identifier"
    && COMBINATORS.has(call.callee.property.name)
  ) return call.callee.property.name;
  return undefined;
}

function provenanceOf(
  collection: string,
  parameters: Set<string>,
): FanoutProvenance {
  const trimmed = collection.trim();
  if (trimmed.startsWith("[")) return "closed-constant";
  const root = /^[A-Za-z_$][\w$]*/.exec(trimmed)?.[0];
  if (root && parameters.has(root)) return "parameter";
  if (/req|request|body|params|query|items/i.test(trimmed)) return "request";
  return "unknown";
}

export function buildUnboundedParallelFanoutEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnboundedParallelFanoutEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseSync(ownerFile.filePath, ownerFile.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const nested = nestedFunctionRanges(parsed.program, fn);

  const imports = moduleImports(parsed.program);
  const limiterImports = imports.filter(({ source }) => LIMITER.test(source)).map(({ source }) => source);
  let limiterPresent = limiterImports.length > 0;
  if (!limiterPresent) {
    new Visitor({
      Identifier(node) {
        if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
        if (/pLimit|pMap|Bottleneck|Semaphore|workerPool/i.test(node.name)) limiterPresent = true;
      },
    }).visit(parsed.program);
  }
  if (limiterPresent) return undefined;

  const parameters = new Set<string>();
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    const match = /^[A-Za-z_$][\w$]*/.exec(ownerFile.source.slice(value.start, value.end));
    if (match?.[0]) parameters.add(match[0]);
  }

  const fanouts: ParallelFanout[] = [];
  new Visitor({
    CallExpression(call) {
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested)) return;
      const combinator = isPromiseCombinator(call);
      if (!combinator || call.arguments.length === 0) return;
      const input = call.arguments[0];
      if (!input) return;
      let collection: string | undefined;
      let callback: Expression | undefined;
      if (input.type === "CallExpression" && input.callee.type === "MemberExpression") {
        const property = input.callee.property;
        const method = property.type === "Identifier" ? property.name : undefined;
        if (method !== "map" && method !== "flatMap") return;
        const first = input.arguments[0];
        if (
          !first
          || (first.type !== "ArrowFunctionExpression" && first.type !== "FunctionExpression")
        ) return;
        if (input.callee.object.type === "Super") return;
        collection = nodeSource(input.callee.object, ownerFile.source);
        callback = first;
      } else if (input.type === "Identifier") {
        collection = nodeSource(input, ownerFile.source);
      } else {
        return;
      }
      const legSource = callback ? nodeSource(callback, ownerFile.source) : collection;
      let heavyLeg = false;
      if (callback) {
        const legRange: NodeRange = { start: callback.start, end: callback.end };
        new Visitor({
          AwaitExpression(node) {
            if (containsNode(legRange, node)) heavyLeg = true;
          },
          CallExpression(node) {
            if (containsNode(legRange, node)) heavyLeg = true;
          },
        }).visit(parsed.program);
      }
      const provenance = provenanceOf(collection, parameters);
      if (provenance === "closed-constant") return;
      fanouts.push({
        source: nodeSource(call, ownerFile.source),
        combinator,
        collection,
        collectionProvenance: provenance,
        legSource,
        heavyLeg,
      });
    },
  }).visit(parsed.program);
  if (fanouts.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    fanouts,
    limiter: {
      present: false,
      imports: limiterImports,
    },
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(candidate.filePath, parsed.program, projectFiles),
    },
  };
}
