import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUndocumentedContractEvidence } from "../src/evidence/undocumented-contract.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string, callerSource?: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/orders.ts", source: ownerSource }];
  if (callerSource !== undefined) {
    projectFiles.push({ filePath: "src/checkout.ts", source: callerSource });
  }
  const candidate = extractCandidates("src/orders.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("process"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no process candidate.");
  return { candidate, projectFiles };
}

const EXPORT = "export function process(items: string[], opts: object, flag: boolean): string {\n"
  + "  if (flag) throw new Error(\"legacy mode removed\");\n"
  + "  return items.join(String(opts));\n"
  + "}\n";

describe("undocumented contract evidence", () => {
  it("reports an undocumented export with cross-module misuse-shaped callers", () => {
    const { candidate, projectFiles } = project(
      EXPORT,
      "import { process } from \"./orders.js\";\n"
      + "export function checkout(): string {\n"
      + "  return process([], {}, true);\n"
      + "}\n",
    );

    const evidence = buildUndocumentedContractEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "process", parameterCount: 3, hasParameterTypes: true },
      documentation: { hasJsdoc: false },
      thrownErrors: [expect.stringContaining("legacy mode removed")],
      crossModuleCallerCount: 1,
      opaqueLiteralCalls: [expect.objectContaining({ filePath: "src/checkout.ts" })],
    });
  });

  it("notes JSDoc presence while still returning evidence", () => {
    const { candidate, projectFiles } = project(
      "/** Processes the order items. */\n" + EXPORT,
    );

    expect(buildUndocumentedContractEvidence(candidate, projectFiles)).toMatchObject({
      documentation: { hasJsdoc: true },
    });
  });

  it("abstains for non-exported functions", () => {
    const source = "function process(items: string[]): string {\n"
      + "  return items.join(\",\");\n"
      + "}\n"
      + "export const result = process([]);\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/orders.ts", source }];
    const candidate = extractCandidates("src/orders.ts", source)
      .filter(({ kind }) => kind === "function")
      .find(({ source: text }) => text.includes("process"));
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("Fixture has no candidate.");

    expect(buildUndocumentedContractEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
