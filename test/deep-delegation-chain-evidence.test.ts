import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDeepDelegationChainEvidence } from "../src/evidence/deep-delegation-chain.js";
import type { ProjectFile } from "../src/types.js";

const entry = `import { handle } from "./mid.js";
export function serve(request: Request) {
  return handle(request);
}
`;

const mid = `import { enforce } from "./policy.js";
export function handle(request: Request) {
  return enforce(request);
}
`;

const policy = `export function enforce(request: Request) {
  if (!request.valid) throw new Error("invalid");
  return { ok: true };
}
`;

const shapingMid = `import { enforce } from "./policy.js";
export function handle(request: Request) {
  const normalized = normalize(request);
  if (!normalized.valid) throw new Error("invalid");
  return enforce(normalized);
}
function normalize(request: Request) {
  return request;
}
`;

const leafMid = `export function handle(request: Request) {
  return { handled: request.url };
}
`;

function files(midSource: string): ProjectFile[] {
  return [
    { filePath: "src/entry.ts", source: entry },
    { filePath: "src/mid.ts", source: midSource },
    { filePath: "src/policy.ts", source: policy },
  ];
}

function candidateFor(source: string) {
  const candidate = extractCandidates("src/entry.ts", source)
    .find(({ kind }) => kind === "function");
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no function candidate.");
  return candidate;
}

describe("deep delegation chain evidence", () => {
  it("traces a two-hop cross-module chain with a pass-through middle", () => {
    const projectFiles = files(mid);
    const evidence = buildDeepDelegationChainEvidence(candidateFor(entry), projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "serve", exported: true },
      chain: { depth: 3, moduleCrossings: 2, passThroughHops: 1 },
    });
    expect(evidence?.chain.hops).toHaveLength(1);
    expect(evidence?.chain.hops[0]).toMatchObject({
      callee: "handle",
      targetModule: "src/mid.ts",
      importedFrom: "./mid.js",
      passThrough: true,
      addsGuard: false,
    });
    expect(evidence?.chain.hops[0]?.next).toContainEqual({
      callee: "enforce",
      targetModule: "src/policy.ts",
      importedFrom: "./policy.js",
    });
  });

  it("marks a shaping middle hop as guarded rather than pass-through", () => {
    const projectFiles = files(shapingMid);
    const evidence = buildDeepDelegationChainEvidence(candidateFor(entry), projectFiles);

    expect(evidence?.chain.hops[0]).toMatchObject({
      passThrough: false,
      addsGuard: true,
    });
  });

  it("abstains when the middle hop does not delegate further", () => {
    const projectFiles = files(leafMid);
    expect(buildDeepDelegationChainEvidence(candidateFor(entry), projectFiles)).toBeUndefined();
  });

  it("abstains when the chain stays inside one module", () => {
    const local = `export function serve(request: Request) {
  return handle(request);
}
function handle(request: Request) {
  return { handled: request.url };
}
`;
    const projectFiles: ProjectFile[] = [{ filePath: "src/entry.ts", source: local }];
    expect(buildDeepDelegationChainEvidence(candidateFor(local), projectFiles)).toBeUndefined();
  });
});
