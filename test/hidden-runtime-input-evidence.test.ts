import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildHiddenRuntimeInputEvidence } from "../src/evidence/hidden-runtime-input.js";
import type { ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function firstFunction(projectFiles: ProjectFile[]) {
  const owner = projectFiles[0];
  expect(owner).toBeDefined();
  if (!owner) throw new Error("Missing fixture owner.");
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find(({ kind }) => kind === "function");
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Missing function candidate.");
  return candidate;
}

describe("hidden runtime input evidence", () => {
  it("extracts an environment read and the callers that cannot supply it", async () => {
    const files = await project("hidden-runtime-input-positive", [
      "src/quote-shipping.ts",
      "src/checkout.ts",
    ]);

    const evidence = buildHiddenRuntimeInputEvidence(firstFunction(files), files);

    expect(evidence).toMatchObject({
      function: { name: "quoteShipping", exported: true },
      runtimeInputs: [
        { kind: "environment", expression: "process.env.PEAK_SHIPPING" },
      ],
      callers: [
        expect.objectContaining({ filePath: "src/checkout.ts", call: "quoteShipping({ weightKg })" }),
      ],
    });
  });

  it("abstains when callers supply the dependency explicitly", async () => {
    const files = await project("hidden-runtime-input-negative", [
      "src/quote-shipping-with-policy.ts",
      "src/checkout.ts",
    ]);

    expect(buildHiddenRuntimeInputEvidence(firstFunction(files), files)).toBeUndefined();
  });

  it("retains adapter context for a legitimate environment boundary", async () => {
    const files = await project("hidden-runtime-input-exception", [
      "src/load-shipping-environment.ts",
      "src/bootstrap.ts",
    ]);

    expect(buildHiddenRuntimeInputEvidence(firstFunction(files), files)).toMatchObject({
      function: {
        name: "loadShippingEnvironment",
        moduleSource: expect.stringContaining("ShippingEnvironment"),
      },
      runtimeInputs: [
        { kind: "environment", expression: "process.env.PEAK_SHIPPING" },
      ],
    });
  });

  it("keeps inherently time-oriented construction available for semantic judgment", async () => {
    const files = await project("hidden-runtime-input-ambiguous", [
      "src/create-trial.ts",
      "src/signup.ts",
    ]);

    expect(buildHiddenRuntimeInputEvidence(firstFunction(files), files)).toMatchObject({
      function: { name: "createTrial" },
      runtimeInputs: [{ kind: "time", expression: "new Date()" }],
    });
  });
});
