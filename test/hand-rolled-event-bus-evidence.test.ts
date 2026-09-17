import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildHandRolledEventBusEvidence } from "../src/evidence/hand-rolled-event-bus.js";
import type { ProjectFile } from "../src/types.js";

const RULE = "jev/no-hand-rolled-event-bus";

function project(ownerSource: string, excerpt: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/bus.ts", source: ownerSource }];
  const candidate = extractCandidates("src/bus.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes(excerpt));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no bus candidate.");
  return { candidate, projectFiles };
}

const SMELLY = "export function createBus() {\n"
  + "  const listeners = new Map<string, Set<(payload: unknown) => void>>();\n"
  + "  return {\n"
  + "    on(topic: string, listener: (payload: unknown) => void): void {\n"
  + "      if (!listeners.has(topic)) listeners.set(topic, new Set());\n"
  + "      listeners.get(topic)?.add(listener);\n"
  + "    },\n"
  + "    off(topic: string, listener: (payload: unknown) => void): void {\n"
  + "      listeners.get(topic)?.delete(listener);\n"
  + "    },\n"
  + "    emit(topic: string, payload: unknown): void {\n"
  + "      listeners.get(topic)?.forEach((listener) => listener(payload));\n"
  + "    },\n"
  + "  };\n"
  + "}\n";

describe("hand rolled event bus wiring", () => {
  it("ships as a function judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({ scope: "function", message: expect.any(String) });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("passes bus factory candidates through dispatch", () => {
    const { candidate, projectFiles } = project(SMELLY, "createBus");

    const result = buildRuleEvidence(RULE, candidate, projectFiles);

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
  });
});

describe("hand rolled event bus evidence", () => {
  it("reports a Map-of-Sets registry with on, off, and emit", () => {
    const { candidate, projectFiles } = project(SMELLY, "createBus");

    const evidence = buildHandRolledEventBusEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "createBus" },
      registrySignals: expect.arrayContaining(["map-registry", "set-listeners"]),
      listenerMethods: expect.arrayContaining(["subscribe", "unsubscribe", "emit"]),
      advancedFeatures: [],
      emitterDepInScope: [],
    });
  });

  it("carries wildcard support as justification signal", () => {
    const { candidate, projectFiles } = project(
      "export function createWildcardBus() {\n"
        + "  const listeners = new Map<string, Set<(payload: unknown) => void>>();\n"
        + "  function matches(pattern: string, topic: string): boolean {\n"
        + "    return pattern === \"*\" || pattern === topic;\n"
        + "  }\n"
        + "  return {\n"
        + "    on: (topic: string, listener: (payload: unknown) => void): void => {\n"
        + "      if (!listeners.has(topic)) listeners.set(topic, new Set());\n"
        + "      listeners.get(topic)?.add(listener);\n"
        + "    },\n"
        + "    emit: (topic: string, payload: unknown): void => {\n"
        + "      for (const [pattern, set] of listeners) {\n"
        + "        if (matches(pattern, topic)) set.forEach((listener) => listener(payload));\n"
        + "      }\n"
        + "    },\n"
        + "  };\n"
        + "}\n",
      "createWildcardBus",
    );

    const evidence = buildHandRolledEventBusEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({ advancedFeatures: expect.arrayContaining(["wildcard"]) });
  });

  it("abstains when no listener registry exists", () => {
    const { candidate, projectFiles } = project(
      "export function createTarget(): EventTarget {\n"
        + "  return new EventTarget();\n"
        + "}\n",
      "createTarget",
    );

    expect(buildHandRolledEventBusEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
