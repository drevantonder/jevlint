import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildRefusedInheritanceEvidence } from "../src/evidence/refused-inheritance.js";
import type { ProjectFile } from "../src/types.js";

const smellyRoot = new URL("./fixtures/repositories/refused-inheritance-smelly/", import.meta.url);
const cleanRoot = new URL("./fixtures/repositories/refused-inheritance-clean/", import.meta.url);

async function load(root: URL, filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

async function project(root: URL, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map((filePath) => load(root, filePath)));
}

function classCandidate(owner: ProjectFile) {
  const candidate = extractCandidates(owner.filePath, owner.source)
    .find(({ kind }) => kind === "abstraction");
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("refused inheritance evidence", () => {
  it("classifies neutralized overrides and supertype-typed usages", async () => {
    const projectFiles = await project(smellyRoot, [
      "src/user.ts",
      "src/ro-user.ts",
      "src/audit.ts",
    ]);
    const owner = projectFiles.find(({ filePath }) => filePath === "src/ro-user.ts")!;
    const evidence = buildRefusedInheritanceEvidence(classCandidate(owner), projectFiles);

    expect(evidence).toMatchObject({
      subclass: { name: "ReadOnlyUser" },
      superclass: {
        name: "User",
        ownership: "project-module",
        filePath: "src/user.ts",
        members: ["delete", "rename", "save"],
      },
      overrides: expect.arrayContaining([
        expect.objectContaining({ name: "save", bodyKind: "throws" }),
        expect.objectContaining({ name: "delete", bodyKind: "constant-return" }),
      ]),
      unusedInherited: ["rename"],
      instantiations: [expect.objectContaining({ filePath: "src/audit.ts" })],
      supertypeUsages: [expect.objectContaining({ filePath: "src/audit.ts" })],
    });
  });

  it("keeps a specializing subclass as evidence rather than abstaining", async () => {
    const projectFiles = await project(cleanRoot, [
      "src/account.ts",
      "src/savings-account.ts",
    ]);
    const owner = projectFiles.find(({ filePath }) => filePath === "src/savings-account.ts")!;
    const evidence = buildRefusedInheritanceEvidence(classCandidate(owner), projectFiles);

    expect(evidence).toMatchObject({
      subclass: { name: "SavingsAccount" },
      overrides: [expect.objectContaining({ name: "credit", bodyKind: "super-delegating" })],
      unusedInherited: [],
    });
  });

  it("abstains when the subclass keeps the whole contract", () => {
    const projectFiles: ProjectFile[] = [
      { filePath: "src/base.ts", source: "export class Base { save(): void {} load(): void {} }" },
      {
        filePath: "src/child.ts",
        source: 'import { Base } from "./base.js";\nexport class Child extends Base {\n  run(): void {\n    this.save();\n    this.load();\n  }\n}',
      },
    ];
    const owner = projectFiles[1]!;
    expect(buildRefusedInheritanceEvidence(classCandidate(owner), projectFiles)).toBeUndefined();
  });

  it("abstains without a resolvable superclass", () => {
    const source = [
      "export class Orphan extends Missing {",
    "  run(): void {}",
      "}",
    ].join("\n");
    const candidate = extractCandidates("src/orphan.ts", source)
      .find(({ kind }) => kind === "abstraction");
    expect(candidate).toBeDefined();
    if (!candidate) return;
    expect(buildRefusedInheritanceEvidence(candidate, [{ filePath: "src/orphan.ts", source }]))
      .toBeUndefined();
  });
});
