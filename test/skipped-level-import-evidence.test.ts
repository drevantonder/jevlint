import { describe, expect, it } from "vitest";
import { buildSkippedLevelImportEvidence } from "../src/evidence/skipped-level-import.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

function projectFile(filePath: string, source = "export const value = 1;\n"): ProjectFile {
  return { filePath, source };
}

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

const button = `export function Button() {
  return "button";
}
`;

const sharedBarrel = `export { Button } from "./ui/button.js";
`;

const formBefore = `import { useState } from "react";
export function Form() {
  return useState(null);
}
`;

const formAfter = `import { useState } from "react";
import { Button } from "../../shared/ui/button.js";
export function Form() {
  return [useState(null), Button()];
}
`;

function repo(formSource: string, formOld: string | null, extra: ProjectFile[] = []) {
  const files = [
    projectFile("features/billing/form.ts", formSource),
    projectFile("features/billing/summary.ts", "export const summary = 1;\n"),
    projectFile("shared/ui/button.ts", button),
    projectFile("shared/ui/input.ts", "export const input = 1;\n"),
    projectFile("shared/index.ts", sharedBarrel),
    ...Array.from({ length: 7 }, (_, index) => projectFile(`features/extra/widget-${index}.ts`)),
    ...extra,
  ];
  const changes: SourceFile[] = [{
    filePath: "features/billing/form.ts",
    source: formSource,
    oldSource: formOld,
    changedLines: [{ start: 2, end: 2 }],
  }];
  return { files, changes };
}

describe("skipped level import evidence", () => {
  it("captures a two-level climb past a nearer barrel", () => {
    const { files, changes } = repo(formAfter, formBefore);

    const evidence = buildSkippedLevelImportEvidence(moduleCandidate("features/billing/form.ts"), files, changes);

    expect(evidence?.climbs).toHaveLength(1);
    expect(evidence?.climbs[0]).toMatchObject({
      specifier: "../../shared/ui/button.js",
      levels: 2,
      resolved: "shared/ui/button.ts",
      alternative: { kind: "barrel", path: "shared/index.ts" },
    });
    expect(evidence?.aliasAvailable).toBe(false);
    expect(evidence?.repoTypicalClimb).toBe(2);
  });

  it("reports an alias alternative when the target tree has no barrel", () => {
    const tsconfig = `{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": { "@/*": ["./*"] }
  }
}
`;
    const { files, changes } = repo(formAfter, formBefore, [projectFile("tsconfig.json", tsconfig)]);

    const withoutBarrel = files.filter(({ filePath }) => filePath !== "shared/index.ts");
    const evidence = buildSkippedLevelImportEvidence(
      moduleCandidate("features/billing/form.ts"),
      withoutBarrel,
      changes,
    );

    expect(evidence?.climbs[0]).toMatchObject({
      specifier: "../../shared/ui/button.js",
      alternative: { kind: "alias" },
    });
    expect(evidence?.aliasAvailable).toBe(true);
  });

  it("emits with no alternative when the repo offers no nearer entry", () => {
    const withoutBarrel = repo(formAfter, formBefore).files.filter(
      ({ filePath }) => filePath !== "shared/index.ts",
    );
    const { changes } = repo(formAfter, formBefore);

    const evidence = buildSkippedLevelImportEvidence(
      moduleCandidate("features/billing/form.ts"),
      withoutBarrel,
      changes,
    );

    expect(evidence?.climbs[0]?.alternative).toBeNull();
    expect(evidence?.aliasAvailable).toBe(false);
  });

  it("abstains for single-level climbs and unresolvable targets", () => {
    const shallow = `import { useState } from "react";
import { summary } from "./summary.js";
export function Form() {
  return [useState(null), summary];
}
`;
    const dangling = `import { useState } from "react";
import { missing } from "../../elsewhere/missing.js";
export function Form() {
  return [useState(null), missing];
}
`;
    const shallowRepo = repo(shallow, formBefore);
    const danglingRepo = repo(dangling, formBefore);

    expect(buildSkippedLevelImportEvidence(
      moduleCandidate("features/billing/form.ts"),
      shallowRepo.files,
      shallowRepo.changes,
    )).toBeUndefined();
    expect(buildSkippedLevelImportEvidence(
      moduleCandidate("features/billing/form.ts"),
      danglingRepo.files,
      danglingRepo.changes,
    )).toBeUndefined();
  });
});
