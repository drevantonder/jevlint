import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnmarkedAbandonedCompatLayerEvidence } from "../src/evidence/unmarked-abandoned-compat-layer.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const repositories = new URL("./fixtures/repositories/", import.meta.url);

async function project(name: string, paths: string[]): Promise<ProjectFile[]> {
  return Promise.all(paths.map(async (filePath) => ({
    filePath,
    source: await readFile(new URL(`${name}/${filePath}`, repositories), "utf8"),
  })));
}

function functionCandidate(source: string, filePath: string, snippet: string): Candidate {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(snippet));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("missing candidate");
  return candidate;
}

describe("unmarked abandoned compat layer evidence", () => {
  it("reports compat naming with zero callers beside an in-use successor", async () => {
    const projectFiles = await project("compat-abandoned", [
      "src/legacyAuth.ts",
      "src/auth.ts",
      "src/app.ts",
    ]);
    const owner = projectFiles[0];
    expect(owner).toBeDefined();
    if (!owner) return;

    const evidence = buildUnmarkedAbandonedCompatLayerEvidence(
      functionCandidate(owner.source, owner.filePath, "legacyAuthenticate"),
      projectFiles,
    );

    expect(evidence).toMatchObject({
      function: { name: "legacyAuthenticate", filePath: "src/legacyAuth.ts" },
      compatNaming: {
        matched: expect.arrayContaining(["legacy"]),
        inFunctionName: true,
        inFileName: true,
      },
      callerCount: 0,
      successors: [
        { name: "authenticate", filePath: "src/auth.ts", useCount: 1 },
      ],
      symbolImporters: [],
    });
  });

  it("abstains when the compat layer still has callers", () => {
    const legacy = "export function legacyAuthenticate(token: string): boolean {\n"
      + "  return token.length > 0;\n"
      + "}\n";
    const auth = "export function authenticate(token: string): boolean {\n"
      + "  return token.trim().length >= 8;\n"
      + "}\n";
    const app = "import { legacyAuthenticate } from \"./legacyAuth.js\";\n"
      + "export function login(token: string): string {\n"
      + "  return legacyAuthenticate(token) ? \"ok\" : \"denied\";\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [
      { filePath: "src/legacyAuth.ts", source: legacy },
      { filePath: "src/auth.ts", source: auth },
      { filePath: "src/app.ts", source: app },
    ];

    expect(buildUnmarkedAbandonedCompatLayerEvidence(
      functionCandidate(legacy, "src/legacyAuth.ts", "legacyAuthenticate"),
      projectFiles,
    )).toBeUndefined();
  });

  it("abstains without compat naming even with a successor-shaped neighbor", () => {
    const owner = "export function renderUser(name: string): string {\n"
      + "  return name;\n"
      + "}\n";
    const sibling = "export function renderUserCard(name: string): string {\n"
      + "  return name.trim();\n"
      + "}\n";
    const app = "import { renderUserCard } from \"./card.js\";\n"
      + "export function page(name: string): string {\n"
      + "  return renderUserCard(name);\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [
      { filePath: "src/user.ts", source: owner },
      { filePath: "src/card.ts", source: sibling },
      { filePath: "src/app.ts", source: app },
    ];

    expect(buildUnmarkedAbandonedCompatLayerEvidence(
      functionCandidate(owner, "src/user.ts", "renderUser"),
      projectFiles,
    )).toBeUndefined();
  });

  it("abstains when no successor exists", () => {
    const source = "export function legacyAuthenticate(token: string): boolean {\n"
      + "  return token.length > 0;\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/legacyAuth.ts", source }];

    expect(buildUnmarkedAbandonedCompatLayerEvidence(
      functionCandidate(source, "src/legacyAuth.ts", "legacyAuthenticate"),
      projectFiles,
    )).toBeUndefined();
  });

  it("abstains for a marked implementation owned by the superseded rule", () => {
    const source = "/** @deprecated use authenticate instead */\n"
      + "export function legacyAuthenticate(token: string): boolean {\n"
      + "  return token.length > 0;\n"
      + "}\n"
      + "export function authenticate(token: string): boolean {\n"
      + "  return token.trim().length >= 8;\n"
      + "}\n";
    const projectFiles: ProjectFile[] = [{ filePath: "src/auth.ts", source }];

    expect(buildUnmarkedAbandonedCompatLayerEvidence(
      functionCandidate(source, "src/auth.ts", "legacyAuthenticate"),
      projectFiles,
    )).toBeUndefined();
  });
});
