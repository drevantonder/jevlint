import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildSensitiveDataInLogEvidence } from "../src/evidence/sensitive-data-in-log.js";
import type { ProjectFile } from "../src/types.js";

function project(ownerSource: string) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/auth.ts", source: ownerSource }];
  const candidate = extractCandidates("src/auth.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("login"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no login candidate.");
  return { candidate, projectFiles };
}

const IMPORT = "import { logger } from \"./log.js\";\n";

describe("sensitive data in log evidence", () => {
  it("reports a secret-named field flowing into a logger", () => {
    const { candidate, projectFiles } = project(
      IMPORT
      + "export function login(password: string) {\n"
      + "  logger.info({ password });\n"
      + "}\n",
    );

    expect(buildSensitiveDataInLogEvidence(candidate, projectFiles)).toMatchObject({
      function: { name: "login" },
      logs: [{
        sink: "logger.info",
        sensitiveFields: ["password"],
        spreadsWholeRecord: false,
        hasRedaction: false,
        loggerImportedFrom: "./log.js",
      }],
    });
  });

  it("resolves a logged record through its declared type one hop", () => {
    const { candidate, projectFiles } = project(
      "interface User { name: string; passwordHash: string; }\n"
      + "export function login(user: User) {\n"
      + "  console.log(user);\n"
      + "}\n",
    );

    expect(buildSensitiveDataInLogEvidence(candidate, projectFiles)).toMatchObject({
      logs: [{
        sensitiveFields: ["passwordHash"],
        loggerImportedFrom: null,
      }],
    });
  });

  it("notes a redaction helper on the path while still returning evidence", () => {
    const { candidate, projectFiles } = project(
      IMPORT
      + "interface User { name: string; ssn: string; }\n"
      + "export function login(user: User) {\n"
      + "  logger.info(redact(user));\n"
      + "}\n",
    );

    expect(buildSensitiveDataInLogEvidence(candidate, projectFiles)).toMatchObject({
      logs: [{
        sensitiveFields: ["ssn"],
        hasRedaction: true,
      }],
    });
  });

  it("abstains for logs without sensitive shape", () => {
    const { candidate, projectFiles } = project(
      "export function login(count: number) {\n"
      + "  console.log(\"starting\", count);\n"
      + "}\n",
    );

    expect(buildSensitiveDataInLogEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when there is no log call", () => {
    const { candidate, projectFiles } = project(
      "export function login(password: string) {\n"
      + "  return password.length > 0;\n"
      + "}\n",
    );

    expect(buildSensitiveDataInLogEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
