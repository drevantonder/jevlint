import { describe, expect, it } from "vitest";
import { buildMutableSurfaceExpansionEvidence } from "../src/evidence/mutable-surface-expansion.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

const beforeStore = `export const storeName = "session";
export class Session {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}
`;

const afterLet = `export const storeName = "session";
export let currentUser: string | null = null;
export class Session {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}
`;

const afterFrozen = `export const storeName = "session";
export const defaultUser = "anon";
export class Session {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}
`;

const afterSetter = `export const storeName = "session";
export class Session {
  readonly id: string;
  private tokenValue = "";
  constructor(id: string) {
    this.id = id;
  }
  set token(value: string) {
    this.tokenValue = value;
  }
}
`;

function candidate(filePath: string): Candidate {
  return {
    id: "change_0",
    kind: "change",
    filePath,
    source: "Whole change. Use the rule-specific before/after evidence.",
    start: 0,
    end: 1,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  };
}

type ChangeScenario = {
  changes: SourceFile[];
  projectFiles: ProjectFile[];
};

function scenario(after: string, changedEnd: number): ChangeScenario {
  const changes: SourceFile[] = [{
    filePath: "src/store.ts",
    source: after,
    oldSource: beforeStore,
    changedLines: [{ start: 1, end: changedEnd }],
  }];
  const projectFiles: ProjectFile[] = [
    { filePath: "src/store.ts", source: after },
    {
      filePath: "src/reader.ts",
      source: "import { storeName } from \"./store\";\nexport const label = storeName;\n",
    },
  ];
  return { changes, projectFiles };
}

describe("mutable surface expansion evidence", () => {
  it("flags an added exported let with the importing module listed", () => {
    const { changes, projectFiles } = scenario(afterLet, 9);
    const evidence = buildMutableSurfaceExpansionEvidence(
      candidate("src/store.ts"),
      changes,
      projectFiles,
    );

    expect(evidence).toMatchObject({
      anchorFile: "src/store.ts",
      expansions: [{ kind: "export-let", name: "currentUser" }],
    });
    expect(evidence?.importers).toEqual([
      { filePath: "src/store.ts", importerCount: 1, importerFiles: ["src/reader.ts"] },
    ]);
  });

  it("flags a setter added to an exported class", () => {
    const { changes, projectFiles } = scenario(afterSetter, 12);
    const evidence = buildMutableSurfaceExpansionEvidence(
      candidate("src/store.ts"),
      changes,
      projectFiles,
    );

    expect(evidence?.expansions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "class-setter", name: "Session.token" }),
      ]),
    );
  });

  it("abstains when the change adds a frozen export", () => {
    const { changes, projectFiles } = scenario(afterFrozen, 9);

    expect(buildMutableSurfaceExpansionEvidence(
      candidate("src/store.ts"),
      changes,
      projectFiles,
    )).toBeUndefined();
  });

  it("abstains when nothing mutable is added", () => {
    const { changes, projectFiles } = scenario(beforeStore, 8);

    expect(buildMutableSurfaceExpansionEvidence(
      candidate("src/store.ts"),
      changes,
      projectFiles,
    )).toBeUndefined();
  });
});
