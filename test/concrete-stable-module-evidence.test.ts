import { describe, expect, it } from "vitest";
import { buildConcreteStableModuleEvidence } from "../src/evidence/concrete-stable-module.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

const concrete = `export class Store {
  get(key: string): string | undefined {
    return key;
  }
}
export function openStore(path: string): Store {
  return new Store();
}
`;

const withContract = `${concrete}
export interface StoreReader {
  get(key: string): string | undefined;
}
`;

const importerA = `import { Store } from "./store.js";
export function read(store: Store): string {
  return store.get("a") ?? "";
}
`;

const importerB = `import { openStore } from "./store.js";
export function boot(): void {
  openStore("/data");
}
`;

function moduleCandidate(filePath: string): Candidate {
  return {
    id: "module_0",
    kind: "module",
    filePath,
    source: "",
    start: 0,
    end: 0,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  };
}

function repo(ownerSource: string) {
  const files: ProjectFile[] = [
    { filePath: "features/storage/store.ts", source: ownerSource },
    { filePath: "features/storage/reader-a.ts", source: importerA },
    { filePath: "features/storage/reader-b.ts", source: importerB },
    ...Array.from(
      { length: 8 },
      (_, index) => ({ filePath: `features/extra/widget-${index}.ts`, source: "export const value = 1;\n" }),
    ),
  ];
  const changes: SourceFile[] = [{
    filePath: "features/storage/store.ts",
    source: ownerSource,
    oldSource: concrete,
    changedLines: [{ start: 1, end: 3 }],
  }];
  return { files, changes };
}

describe("concrete stable module evidence", () => {
  it("reports importer spread against an all-concrete export list", () => {
    const { files, changes } = repo(concrete);

    const evidence = buildConcreteStableModuleEvidence(
      moduleCandidate("features/storage/store.ts"),
      files,
      changes,
    );

    expect(evidence?.exports).toEqual({
      abstract: [],
      concrete: [
        { name: "openStore", kind: "function" },
        { name: "Store", kind: "class" },
      ],
    });
    expect(evidence?.importers).toMatchObject({
      count: 2,
      files: ["features/storage/reader-a.ts", "features/storage/reader-b.ts"],
      symbols: ["Store", "openStore"],
    });
  });

  it("abstains when the module offers an abstract surface", () => {
    const { files, changes } = repo(withContract);
    expect(buildConcreteStableModuleEvidence(moduleCandidate("features/storage/store.ts"), files, changes))
      .toBeUndefined();
  });

  it("abstains when nobody imports the module", () => {
    const { files, changes } = repo(concrete);
    const lonely = files.filter((file) => file.filePath === "features/storage/store.ts" || file.filePath.startsWith("features/extra/"));
    expect(buildConcreteStableModuleEvidence(moduleCandidate("features/storage/store.ts"), lonely, changes))
      .toBeUndefined();
  });
});
