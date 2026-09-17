import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDuplicatedStyleObjectEvidence } from "../src/evidence/duplicated-style-object.js";
import type { ProjectFile } from "../src/types.js";

const CARD = "const card = {\n"
  + "    borderRadius: 8,\n"
  + "    boxShadow: \"0 1px 4px rgba(0,0,0,0.12)\",\n"
  + "    padding: 16,\n"
  + "    backgroundColor: \"#ffffff\",\n"
  + "    margin: 12,\n"
  + "  };\n";

function project(): ProjectFile[] {
  return [
    {
      filePath: "src/theme.ts",
      source: "export const theme = {\n"
        + "  radius: 8,\n"
        + "  spacing: 16,\n"
        + "};\n",
    },
    {
      filePath: "src/CardA.tsx",
      source: "import { theme } from \"./theme.js\";\n"
        + `export function CardA(): unknown {\n  ${CARD}  return card;\n}\n`,
    },
    {
      filePath: "src/CardB.tsx",
      source: `export function CardB(): unknown {\n  ${CARD}  return card;\n}\n`,
    },
  ];
}

function candidateFor(projectFiles: ProjectFile[]) {
  const owner = projectFiles.find(({ filePath }) => filePath === "src/CardA.tsx");
  expect(owner).toBeDefined();
  if (!owner) throw new Error("Fixture has no CardA file.");
  const candidate = extractCandidates(owner.filePath, owner.source)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("CardA"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no candidate.");
  return candidate;
}

describe("duplicated style object evidence", () => {
  it("reports a byte-identical style object beside a theme module", () => {
    const projectFiles = project();
    const candidate = candidateFor(projectFiles);

    const evidence = buildDuplicatedStyleObjectEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      matches: [expect.objectContaining({
        filePath: "src/CardB.tsx",
        sharedEntries: expect.arrayContaining(["borderRadius=8", "padding=16", "margin=12"]),
      })],
      themeModules: [expect.objectContaining({ filePath: "src/theme.ts" })],
    });
  });

  it("abstains when the style object has no cross-component twin", () => {
    const projectFiles: ProjectFile[] = [{
      filePath: "src/CardA.tsx",
      source: "export function CardA(): unknown {\n"
        + "  const card = {\n"
        + "    borderRadius: 4,\n"
        + "    padding: 8,\n"
        + "    margin: 2,\n"
        + "    color: \"red\",\n"
        + "  };\n"
        + "  return card;\n"
        + "}\n",
    }];
    const candidate = candidateFor(projectFiles);

    expect(buildDuplicatedStyleObjectEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when no style-shaped object exists", () => {
    const projectFiles: ProjectFile[] = [{
      filePath: "src/CardA.tsx",
      source: "export function CardA(name: string): string {\n"
        + "  return name.toUpperCase();\n"
        + "}\n",
    }];
    const candidate = candidateFor(projectFiles);

    expect(buildDuplicatedStyleObjectEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
