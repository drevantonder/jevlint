import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type HandRolledEventBusEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  registrySignals: string[];
  listenerMethods: string[];
  advancedFeatures: string[];
  emitterDepInScope: string[];
  callers: FunctionCaller[];
};

const REGISTRY_PATTERNS: Array<[RegExp, string]> = [
  [/new\s+Map/, "map-registry"],
  [/new\s+Set/, "set-listeners"],
  [/\[\s*\]\s*;\s*\n?\s*[^;]*\.push\(|\.push\(.*listener/i, "array-listeners"],
];
const LISTENER_METHOD_PATTERNS: Array<[RegExp, string]> = [
  [/\b(on|subscribe|addListener|addEventListener)\b/, "subscribe"],
  [/\b(off|unsubscribe|removeListener|removeEventListener)\b/, "unsubscribe"],
  [/\b(emit|dispatch|publish|broadcast)\b/, "emit"],
  [/\b(once)\b/, "once"],
];
const ADVANCED_FEATURE_PATTERNS: Array<[RegExp, string]> = [
  [/["']\*["']|\*\*|wildcard/i, "wildcard"],
  [/replay|history|buffer/i, "replay"],
  [/backpressure|queue|drain/i, "backpressure"],
];
const EMITTER_DEP_PATTERN = /mitt|eventemitter|tiny-emitter|tinyemitter|rxjs|event-target|mitt-/i;

export function buildHandRolledEventBusEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HandRolledEventBusEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const registrySignals = REGISTRY_PATTERNS
    .filter(([pattern]) => pattern.test(candidate.source))
    .map(([, label]) => label);
  if (!registrySignals.includes("map-registry")) return undefined;

  const listenerMethods = LISTENER_METHOD_PATTERNS
    .filter(([pattern]) => pattern.test(candidate.source))
    .map(([, label]) => label);
  if (!listenerMethods.includes("emit")) return undefined;
  if (!listenerMethods.includes("subscribe") && !listenerMethods.includes("unsubscribe")) {
    return undefined;
  }

  const advancedFeatures = ADVANCED_FEATURE_PATTERNS
    .filter(([pattern]) => pattern.test(candidate.source))
    .map(([, label]) => label);

  const emitterDepInScope = moduleImports(parsed.program)
    .map(({ source }) => source)
    .filter((source, index, all) => all.indexOf(source) === index)
    .filter((source) => EMITTER_DEP_PATTERN.test(source))
    .slice(0, 10);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    registrySignals,
    listenerMethods,
    advancedFeatures,
    emitterDepInScope,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
