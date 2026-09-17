import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildTemporalCallCouplingEvidence } from "../src/evidence/temporal-call-coupling.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string, callerSource?: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/db.ts", source: ownerSource }];
  if (callerSource !== undefined) {
    projectFiles.push({ filePath: "src/service.ts", source: callerSource });
  }
  const candidate = extractCandidates("src/db.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("query"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no query candidate.");
  return { candidate, projectFiles };
}

const SMELLY = "let connection: string | undefined;\n"
  + "export function connect(url: string): void {\n"
  + "  connection = url;\n"
  + "}\n"
  + "export function query(sql: string): string {\n"
  + "  return `${connection}:${sql}`;\n"
  + "}\n";

describe("temporal call coupling evidence", () => {
  it("pairs a reader with its setup writer and flags reader-alone call sites", () => {
    const { candidate, projectFiles } = project(
      SMELLY,
      "import { query } from \"./db.js\";\n"
      + "export function handle(sql: string): string {\n"
      + "  return query(sql);\n"
      + "}\n",
    );

    const evidence = buildTemporalCallCouplingEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "query", exported: true },
      sharedState: [
        {
          binding: "connection",
          setupSuggestingWriter: true,
          guardPresent: false,
          writers: [{ name: "connect" }],
        },
      ],
      readerAloneCallers: [expect.objectContaining({ filePath: "src/service.ts" })],
    });
  });

  it("notes when the reader guards on the shared state", () => {
    const guarded = SMELLY.replace(
      "return `${connection}:${sql}`;",
      "if (!connection) throw new Error(\"not connected\");\n  return `${connection}:${sql}`;",
    );
    const { candidate, projectFiles } = project(guarded);

    expect(buildTemporalCallCouplingEvidence(candidate, projectFiles)).toMatchObject({
      sharedState: [expect.objectContaining({ guardPresent: true })],
    });
  });

  it("abstains when no sibling writes the state the candidate reads", () => {
    const { candidate, projectFiles } = project(
      "const dsn = \"postgres://localhost/app\";\n"
      + "export function query(sql: string): string {\n"
      + "  return `${dsn}:${sql}`;\n"
      + "}\n",
    );

    expect(buildTemporalCallCouplingEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
