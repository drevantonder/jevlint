import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { defaultConfig } from "../src/config.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildHandRolledPromiseTimeoutEvidence } from "../src/evidence/hand-rolled-promise-timeout.js";
import type { ProjectFile } from "../src/types.js";

const RULE = "jev/no-hand-rolled-promise-timeout";

function project(ownerSource: string, excerpt: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/fetch.ts", source: ownerSource }];
  const candidate = extractCandidates("src/fetch.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes(excerpt));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no timeout candidate.");
  return { candidate, projectFiles };
}

const SMELLY = "export function fetchWithTimeout(url: string, ms: number): Promise<string> {\n"
  + "  let timer: ReturnType<typeof setTimeout>;\n"
  + "  const timeout = new Promise<never>((_, reject) => {\n"
  + "    timer = setTimeout(() => reject(new Error(\"request timed out\")), ms);\n"
  + "  });\n"
  + "  return Promise.race([fetch(url).then((response) => response.text()), timeout])\n"
  + "    .finally(() => clearTimeout(timer));\n"
  + "}\n";

describe("hand rolled promise timeout wiring", () => {
  it("ships as a function judgment without thresholds", () => {
    expect(defaultConfig.rules[RULE]).toMatchObject({ scope: "function", message: expect.any(String) });
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("threshold");
    expect(defaultConfig.rules[RULE]).not.toHaveProperty("severity");
  });

  it("passes timeout race candidates through dispatch", () => {
    const { candidate, projectFiles } = project(SMELLY, "fetchWithTimeout");

    const result = buildRuleEvidence(RULE, candidate, projectFiles);

    expect(result).toEqual({ handled: true, evidence: expect.any(Object) });
  });
});

describe("hand rolled promise timeout evidence", () => {
  it("reports a setTimeout race with cleanup around fetch", () => {
    const { candidate, projectFiles } = project(SMELLY, "fetchWithTimeout");

    const evidence = buildHandRolledPromiseTimeoutEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "fetchWithTimeout" },
      timeoutRaces: expect.arrayContaining([expect.objectContaining({ call: expect.stringContaining("setTimeout") })]),
      clearsTimeout: true,
      signalThreaded: false,
      taskSignals: expect.arrayContaining(["timeout", "fetch("]),
    });
  });

  it("notes a threaded signal as justification signal", () => {
    const { candidate, projectFiles } = project(
      "export function pollWithTimeout(task: (signal: AbortSignal) => Promise<string>, ms: number): Promise<string> {\n"
        + "  const controller = new AbortController();\n"
        + "  const timeout = new Promise<never>((_, reject) => {\n"
        + "    setTimeout(() => reject(new Error(\"poll timed out\")), ms);\n"
        + "  });\n"
        + "  return Promise.race([task(controller.signal), timeout]);\n"
        + "}\n",
      "pollWithTimeout",
    );

    const evidence = buildHandRolledPromiseTimeoutEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({ signalThreaded: true });
  });

  it("abstains where the platform mechanism is already used", () => {
    const { candidate, projectFiles } = project(
      "export function fetchBounded(url: string): Promise<string> {\n"
        + "  return fetch(url, { signal: AbortSignal.timeout(5000) }).then((response) => response.text());\n"
        + "}\n",
      "fetchBounded",
    );

    expect(buildHandRolledPromiseTimeoutEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when no deadline mechanism exists", () => {
    const { candidate, projectFiles } = project(
      "export function fetchOpen(url: string): Promise<string> {\n"
        + "  return fetch(url).then((response) => response.text());\n"
        + "}\n",
      "fetchOpen",
    );

    expect(buildHandRolledPromiseTimeoutEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
