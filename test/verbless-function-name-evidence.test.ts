import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildVerblessFunctionNameEvidence } from "../src/evidence/verbless-function-name.js";
import type { ProjectFile } from "../src/types.js";

const SMELLY = `const sessions = new Map<string, string>();

export function session(token: string): string {
  const cached = sessions.get(token);
  if (cached !== undefined) {
    return cached;
  }
  const created = "session:" + token;
  sessions.set(token, created);
  return created;
}
`;

const CALLER = `import { session } from "./session.js";

export function getSession(token: string): string {
  return session(token);
}
`;

const VERBED = `export function getSession(token: string): string {
  return "session:" + token;
}
`;

function candidate(source: string, filePath: string) {
  return extractCandidates(filePath, source).find(({ kind }) => kind === "function");
}

describe("verbless function name evidence", () => {
  it("reports a noun-named function with effects and branch selection", () => {
    const files: ProjectFile[] = [
      { filePath: "src/session.ts", source: SMELLY },
      { filePath: "src/page.ts", source: CALLER },
    ];
    const fn = candidate(SMELLY, "src/session.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    const evidence = buildVerblessFunctionNameEvidence(fn, files);

    expect(evidence).toMatchObject({
      function: { name: "session", firstWord: "session", frameworkConventional: false },
      body: { calls: expect.any(Number), branches: 1 },
    });
    expect(evidence?.callers).toHaveLength(1);
  });

  it("abstains when the name carries a verb head", () => {
    const files: ProjectFile[] = [{ filePath: "src/session.ts", source: VERBED }];
    const fn = candidate(VERBED, "src/session.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildVerblessFunctionNameEvidence(fn, files)).toBeUndefined();
  });
});
