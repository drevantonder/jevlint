import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildAccidentalSerializationEvidence } from "../src/evidence/accidental-serialization.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/users.ts", source: ownerSource }];
  const candidate = extractCandidates("src/users.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("await"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no await candidate.");
  return { candidate, projectFiles };
}

const INDEPENDENT = "import { fetchUser } from \"./client.js\";\n"
  + "export async function syncUsers(ids: string[]): Promise<Record<string, unknown>> {\n"
  + "  const results: Record<string, unknown> = {};\n"
  + "  for (const id of ids) {\n"
  + "    const user = await fetchUser(id);\n"
  + "    results[id] = user;\n"
  + "  }\n"
  + "  return results;\n"
  + "}\n";

const FOLDING = "import { loadValue } from \"./store.js\";\n"
  + "export async function totalize(items: string[]): Promise<number> {\n"
  + "  let total = 0;\n"
  + "  for (const item of items) {\n"
  + "    const value = await loadValue(item);\n"
  + "    total += value;\n"
  + "  }\n"
  + "  return total;\n"
  + "}\n";

describe("accidental serialization evidence", () => {
  it("reports an independent await-in-loop with keyed storage and callee import", () => {
    const { candidate, projectFiles } = project(INDEPENDENT);

    const evidence = buildAccidentalSerializationEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "syncUsers", exported: true },
      loops: [
        expect.objectContaining({
          loopKind: "for-of",
          awaitedCalls: [expect.stringContaining("fetchUser")],
        }),
      ],
      loopWritesOuterBinding: false,
      accumulationSignals: false,
      orderingSignals: expect.objectContaining({ resultIndexedByElement: true }),
      calleeImportSources: ["./client.js"],
    });
  });

  it("flags shared accumulation in a folding loop", () => {
    const { candidate, projectFiles } = project(FOLDING);

    expect(buildAccidentalSerializationEvidence(candidate, projectFiles)).toMatchObject({
      loopWritesOuterBinding: true,
      accumulationSignals: true,
    });
  });

  it("abstains when awaits never occur inside a loop", () => {
    const source = "import { fetchUser } from \"./client.js\";\n"
      + "export async function fetchTwo(first: string, second: string): Promise<unknown[]> {\n"
      + "  const one = await fetchUser(first);\n"
      + "  const two = await fetchUser(second);\n"
      + "  return [one, two];\n"
      + "}\n";
    const { candidate, projectFiles } = project(source);

    expect(buildAccidentalSerializationEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
