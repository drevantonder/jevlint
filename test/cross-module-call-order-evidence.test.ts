import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildCrossModuleCallOrderEvidence } from "../src/evidence/cross-module-call-order.js";
import type { ProjectFile } from "../src/types.js";

const STORE = `let current: string | undefined;
export function open(id: string): void {
  current = id;
}
export function read(): string {
  return current ?? "none";
}
`;

const GUARDED_STORE = `let current: string | undefined;
export function open(id: string): void {
  current = id;
}
export function read(): string {
  if (!current) throw new Error("not open");
  return current;
}
`;

const COMBINED_STORE = `${STORE}export function openAndRead(id: string): string {
  open(id);
  return read();
}
`;

const OWNER = `import { open, read } from "./store.js";
export function boot(id: string): string {
  open(id);
  return read();
}
`;

const SECOND_CALLER = `import { open, read } from "./store.js";
export function reboot(id: string): string {
  read();
  open(id);
  return read();
}
`;

function project(ownerSource: string, storeSource: string, extra: ProjectFile[] = []) {
  const projectFiles: ProjectFile[] = [
    { filePath: "src/app.ts", source: ownerSource },
    { filePath: "src/store.ts", source: storeSource },
    ...extra,
  ];
  const candidate = extractCandidates("src/app.ts", ownerSource)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("boot") && !source.includes("reboot"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no boot candidate.");
  return { candidate, projectFiles };
}

describe("cross module call order evidence", () => {
  it("pairs a writer and reader sharing one target binding", () => {
    const { candidate, projectFiles } = project(OWNER, STORE);

    const evidence = buildCrossModuleCallOrderEvidence(candidate, projectFiles);

    expect(evidence?.pairs).toHaveLength(1);
    expect(evidence?.pairs[0]).toMatchObject({
      first: "open",
      second: "read",
      targetModule: "src/store.ts",
      binding: "current",
      guardPresent: false,
      combinedEntryPoints: [],
    });
  });

  it("notes guards and combined entry points for Jev to weigh", () => {
    const { candidate, projectFiles } = project(OWNER, COMBINED_STORE);
    const guarded = project(OWNER, GUARDED_STORE);

    expect(buildCrossModuleCallOrderEvidence(candidate, projectFiles)?.pairs[0]).toMatchObject({
      combinedEntryPoints: ["openAndRead"],
    });
    expect(buildCrossModuleCallOrderEvidence(guarded.candidate, guarded.projectFiles)?.pairs[0])
      .toMatchObject({ guardPresent: true });
  });

  it("samples call-site orderings from sibling callers", () => {
    const { candidate, projectFiles } = project(OWNER, STORE, [
      { filePath: "src/other.ts", source: SECOND_CALLER },
    ]);

    const evidence = buildCrossModuleCallOrderEvidence(candidate, projectFiles);

    const convention = evidence?.conventions.find(({ first, second }) => first === "open" && second === "read");
    expect(convention?.orderings).toContainEqual({ filePath: "src/app.ts", firstBeforeSecond: true });
    expect(convention?.orderings).toContainEqual({ filePath: "src/other.ts", firstBeforeSecond: false });
  });

  it("abstains when the callees share no write-read binding", () => {
    const independent = `export function alpha(): string {
  return "a";
}
export function beta(): string {
  return "b";
}
`;
    const owner = `import { alpha, beta } from "./store.js";
export function boot(): string {
  return alpha() + beta();
}
`;
    const { candidate, projectFiles } = project(owner, independent);

    expect(buildCrossModuleCallOrderEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
