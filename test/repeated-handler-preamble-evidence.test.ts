import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildRepeatedHandlerPreambleEvidence } from "../src/evidence/repeated-handler-preamble.js";

const moduleSource = `
  import { reportError } from "./telemetry";
  export function createUser(payload: unknown): string {
    if (!payload) {
      reportError("empty payload");
      throw new Error("empty payload");
    }
    return "user";
  }
  export function deleteUser(payload: unknown): string {
    if (!payload) {
      reportError("empty payload");
      throw new Error("empty payload");
    }
    return "deleted";
  }
  export function renameUser(name: string): string {
    return name.trim();
  }
`;

function candidateFor(snippet: string) {
  const candidate = extractCandidates("src/users.ts", moduleSource)
    .find(({ kind, source }) => kind === "function" && source.includes(snippet));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("candidate missing");
  return candidate;
}

describe("repeated handler preamble evidence", () => {
  it("matches a sibling with the identical preamble and the shared helper", () => {
    const candidate = candidateFor("function createUser");

    expect(buildRepeatedHandlerPreambleEvidence(
      candidate,
      [
        { filePath: "src/users.ts", source: moduleSource },
        { filePath: "src/telemetry.ts", source: "export function reportError(): void {}" },
      ],
    )).toMatchObject({
      function: { name: "createUser", exported: true },
      preamble: { statements: [expect.stringContaining("if (!payload)")] },
      repetitions: [{ sibling: "deleteUser" }],
      sharedHelpers: expect.arrayContaining(["reportError"]),
    });
  });

  it("abstains when the function opens with no guard preamble", () => {
    const candidate = candidateFor("function renameUser");

    expect(buildRepeatedHandlerPreambleEvidence(
      candidate,
      [{ filePath: "src/users.ts", source: moduleSource }],
    )).toBeUndefined();
  });
});
