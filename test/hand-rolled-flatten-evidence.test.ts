import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildHandRolledFlattenEvidence } from "../src/evidence/hand-rolled-flatten.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string, filePath = "src/tree.ts") {
  const projectFiles: ProjectFile[] = [{ filePath, source: ownerSource }];
  const candidate = extractCandidates(filePath, ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("function "));
  expect(candidate).toBeDefined();
  expect(candidate?.kind).toBe("function");
  if (!candidate) throw new Error("Fixture has no function candidate.");
  return { candidate, projectFiles };
}

describe("hand rolled flatten evidence", () => {
  it("reports self-recursive full-depth flattening", () => {
    const { candidate, projectFiles } = project(
      "export function flattenAll(nested: unknown[]): unknown[] {\n"
      + "  let out: unknown[] = [];\n"
      + "  for (const item of nested) {\n"
      + "    if (Array.isArray(item)) out = out.concat(flattenAll(item));\n"
      + "    else out.push(item);\n"
      + "  }\n"
      + "  return out;\n"
      + "}\n",
    );

    const evidence = buildHandRolledFlattenEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "flattenAll" },
      selfRecursive: true,
      concatSignals: expect.arrayContaining([expect.stringContaining("concat")]),
      depthParameter: null,
      justification: { depthCapWithMeaning: false, lazyIteration: false },
    });
  });

  it("carries a depth parameter with domain meaning", () => {
    const { candidate, projectFiles } = project(
      "export function flattenLevels(nested: unknown[], depth: number): unknown[] {\n"
      + "  if (depth === 0) return nested.slice();\n"
      + "  let out: unknown[] = [];\n"
      + "  for (const item of nested) {\n"
      + "    if (Array.isArray(item)) out = out.concat(flattenLevels(item, depth - 1));\n"
      + "    else out.push(item);\n"
      + "  }\n"
      + "  return out;\n"
      + "}\n",
    );

    const evidence = buildHandRolledFlattenEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      selfRecursive: true,
      depthParameter: "depth",
      justification: { depthCapWithMeaning: true },
    });
  });

  it("abstains for a recursive walk without concatenation", () => {
    const source = "export function countNodes(node: Tree): number {\n"
      + "  if (!Array.isArray(node.children)) return 1;\n"
      + "  return 1 + node.children.reduce((sum, child) => sum + countNodes(child), 0);\n"
      + "}\n";
    const { candidate, projectFiles } = project(source);

    expect(buildHandRolledFlattenEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
