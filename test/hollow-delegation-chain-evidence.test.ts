import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildHollowDelegationChainEvidence } from "../src/evidence/hollow-delegation-chain.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import type { ProjectFile } from "../src/types.js";

const CHAIN = "export function entry(value: string): string {\n"
  + "  return second(value);\n"
  + "}\n"
  + "function second(value: string): string {\n"
  + "  return third(value);\n"
  + "}\n"
  + "function third(value: string): string {\n"
  + "  return work(value);\n"
  + "}\n"
  + "function work(value: string): string {\n"
  + "  return value.toUpperCase();\n"
  + "}\n";

function project(ownerSource: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/chain.ts", source: ownerSource }];
  const candidate = extractCandidates("src/chain.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("entry"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no entry candidate.");
  return { candidate, projectFiles };
}

describe("hollow delegation chain evidence", () => {
  it("traces three same-module hops to the working target", () => {
    const { candidate, projectFiles } = project(CHAIN);

    const evidence = buildHollowDelegationChainEvidence(candidate, projectFiles);

    expect(evidence?.chainLength).toBe(3);
    expect(evidence?.hops.map(({ name }) => name)).toEqual(["entry", "second", "third"]);
    expect(evidence?.finalTarget).toBe("work");
    expect(evidence?.hops.every(({ filePath }) => filePath === "src/chain.ts")).toBe(true);
  });

  it("abstains below three hops", () => {
    const { candidate, projectFiles } = project(
      "export function entry(value: string): string {\n"
      + "  return work(value);\n"
      + "}\n"
      + "function work(value: string): string {\n"
      + "  return value.toUpperCase();\n"
      + "}\n",
    );

    expect(buildHollowDelegationChainEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when a hop adds behavior or leaves the module", () => {
    const branching = project(
      "export function entry(value: string): string {\n"
      + "  return second(value);\n"
      + "}\n"
      + "function second(value: string): string {\n"
      + "  if (value.length === 0) {\n"
      + "    return value;\n"
      + "  }\n"
      + "  return third(value);\n"
      + "}\n"
      + "function third(value: string): string {\n"
      + "  return work(value);\n"
      + "}\n"
      + "function work(value: string): string {\n"
      + "  return value;\n"
      + "}\n",
    );
    expect(buildHollowDelegationChainEvidence(branching.candidate, branching.projectFiles)).toBeUndefined();

    const source = "import { remote } from \"./remote\";\n"
      + "export function entry(value: string): string {\n"
      + "  return remote(value);\n"
      + "}\n";
    const remoteFiles: ProjectFile[] = [
      { filePath: "src/entry.ts", source },
      { filePath: "src/remote.ts", source: "export function remote(value: string): string {\n  return value;\n}\n" },
    ];
    const remoteCandidate = extractCandidates("src/entry.ts", source)
      .filter(({ kind }) => kind === "function")
      .find(({ source: text }) => text.includes("entry"));
    expect(remoteCandidate).toBeDefined();
    if (!remoteCandidate) throw new Error("Fixture has no entry candidate.");
    expect(buildHollowDelegationChainEvidence(remoteCandidate, remoteFiles)).toBeUndefined();
  });

  it("abstains for non-function candidates and dispatches the rule id", () => {
    const { candidate, projectFiles } = project(CHAIN);
    expect(buildHollowDelegationChainEvidence({ ...candidate, kind: "comment" }, projectFiles)).toBeUndefined();
    expect(buildRuleEvidence("jev/no-hollow-delegation-chain", candidate, projectFiles)).toMatchObject({
      handled: true,
      evidence: expect.anything(),
    });
  });
});
