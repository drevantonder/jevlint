import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildChattyInterfaceEvidence } from "../src/evidence/chatty-interface.js";
import type { ProjectFile } from "../src/types.js";

const USERS = `export async function getUser(id: string): Promise<string> {
  return id;
}
export async function getUsers(ids: string[]): Promise<string[]> {
  return ids;
}
`;

const SMELLY = `import { getUser } from "./users.js";
export async function syncAll(client: string, ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    out.push(await getUser(client, id));
  }
  return out;
}
`;

function project(ownerSource: string, functionName = "syncAll") {
  const projectFiles: ProjectFile[] = [
    { filePath: "src/sync.ts", source: ownerSource },
    { filePath: "src/users.ts", source: USERS },
  ];
  const candidate = extractCandidates("src/sync.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes(functionName));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no function candidate.");
  return { candidate, projectFiles };
}

describe("chatty interface evidence", () => {
  it("captures an awaited per-item call with invariant args and a batch sibling", () => {
    const { candidate, projectFiles } = project(SMELLY);

    const evidence = buildChattyInterfaceEvidence(candidate, projectFiles);

    expect(evidence?.loops).toHaveLength(1);
    expect(evidence?.loops[0]).toMatchObject({ kind: "ForOfStatement" });
    expect(evidence?.loops[0]?.calls).toHaveLength(1);
    expect(evidence?.loops[0]?.calls[0]).toMatchObject({
      callee: "getUser",
      targetModule: "src/users.ts",
      awaited: true,
      invariantArgs: ["client"],
      variantArgs: ["id"],
    });
    expect(evidence?.loops[0]?.batchSiblings).toEqual([
      { targetModule: "src/users.ts", names: ["getUsers"] },
    ]);
  });

  it("abstains when the loop carries no cross-module call", () => {
    const local = `export async function total(ids: string[]): Promise<number> {
  let sum = 0;
  for (const id of ids) {
    sum += id.length;
  }
  return sum;
}
`;
    const projectFiles: ProjectFile[] = [{ filePath: "src/sync.ts", source: local }];
    const candidate = extractCandidates("src/sync.ts", local)
      .filter(({ kind }) => kind === "function")
      .find(({ source }) => source.includes("total"));
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("Fixture has no total candidate.");

    expect(buildChattyInterfaceEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when the function has no loop", () => {
    const straight = `import { getUser } from "./users.js";
export async function fetchOne(client: string, id: string): Promise<string> {
  return getUser(client, id);
}
`;
    const { candidate, projectFiles } = project(straight, "fetchOne");

    expect(buildChattyInterfaceEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
