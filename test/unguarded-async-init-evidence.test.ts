import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnguardedAsyncInitEvidence } from "../src/evidence/unguarded-async-init.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `let conn: { query: (sql: string) => void } | undefined;
export async function handleRequest() {
  if (!conn) conn = await connect();
  return conn;
}
async function connect() {
  return { query: () => {} };
}
`;

const guarded = `let conn: { query: (sql: string) => void } | undefined;
let pending: Promise<{ query: (sql: string) => void }> | undefined;
export async function handleRequest() {
  if (!conn) {
    pending ??= connect();
    conn = await pending;
  }
  return conn;
}
async function connect() {
  return { query: () => {} };
}
`;

const local = `export async function handleRequest() {
  let conn: { query: (sql: string) => void } | undefined;
  if (!conn) conn = await connect();
  return conn;
}
async function connect() {
  return { query: () => {} };
}
`;

function project(source: string, filePath = "src/db.ts", extra: ProjectFile[] = []) {
  return { files: [{ filePath, source }, ...extra], filePath };
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("unguarded async init evidence", () => {
  it("captures a memoize-on-empty guard with an awaited init", () => {
    const { files, filePath } = project(smelly);
    const evidence = buildUnguardedAsyncInitEvidence(candidateFor(smelly, filePath, "handleRequest"), files);

    expect(evidence).toMatchObject({
      function: { name: "handleRequest", exported: true },
      guards: [{ binding: "conn", bindingScope: "module", guardKind: "falsy-check" }],
      inFlightSharing: { present: false },
    });
    expect(evidence?.guards[0]?.awaitedInit).toContain("await connect()");
  });

  it("captures a nullish-assign guard", () => {
    const source = `let client: { close: () => void } | undefined;
export async function handleRequest() {
  client ??= await createClient();
  return client;
}
async function createClient() {
  return { close: () => {} };
}
`;
    const { files, filePath } = project(source);
    const evidence = buildUnguardedAsyncInitEvidence(candidateFor(source, filePath, "handleRequest"), files);

    expect(evidence?.guards).toMatchObject([{ binding: "client", guardKind: "nullish-assign" }]);
  });

  it("records the shared in-flight slot as weakening evidence", () => {
    const { files, filePath } = project(guarded);
    const evidence = buildUnguardedAsyncInitEvidence(candidateFor(guarded, filePath, "pending ??= connect()"), files);

    expect(evidence?.guards).toMatchObject([{ binding: "conn", guardKind: "falsy-check" }]);
    expect(evidence?.inFlightSharing.present).toBe(true);
    expect(evidence?.inFlightSharing.awaited).toContain("pending");
  });

  it("marks function-local bindings as per-entry", () => {
    const { files, filePath } = project(local);
    const evidence = buildUnguardedAsyncInitEvidence(candidateFor(local, filePath, "handleRequest"), files);

    expect(evidence?.guards).toMatchObject([{ binding: "conn", bindingScope: "local" }]);
  });

  it("abstains when initialization is eager", () => {
    const source = `const conn = { query: () => {} };
export async function handleRequest() {
  return conn;
}
`;
    const { files, filePath } = project(source);
    expect(buildUnguardedAsyncInitEvidence(candidateFor(source, filePath, "handleRequest"), files))
      .toBeUndefined();
  });

  it("abstains when the guard has no awaited init", () => {
    const source = `let cache: Record<string, string> = {};
export function handleRequest(key: string) {
  if (!cache[key]) cache[key] = "default";
  return cache[key];
}
`;
    const { files, filePath } = project(source);
    expect(buildUnguardedAsyncInitEvidence(candidateFor(source, filePath, "handleRequest"), files))
      .toBeUndefined();
  });
});
