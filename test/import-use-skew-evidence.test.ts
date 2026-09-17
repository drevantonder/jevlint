import { describe, expect, it } from "vitest";
import { buildImportUseSkewEvidence } from "../src/evidence/import-use-skew.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

const skewed = `import { format, parse, validate, serialize } from "./toolbox.js";
export function run(raw: string): string {
  return format(raw);
}
`;

const balanced = `import { format, parse } from "./toolbox.js";
export function run(raw: string): string {
  return format(parse(raw));
}
`;

const toolbox = `export function format(value: string): string {
  return value;
}
export function parse(value: string): string {
  return value;
}
export function validate(value: string): boolean {
  return value.length > 0;
}
export function serialize(value: string): string {
  return value;
}
`;

const barrel = `export { format } from "./toolbox.js";
export function run(raw: string): string {
  return raw;
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
    { filePath: "features/worker/run.ts", source: ownerSource },
    { filePath: "features/worker/toolbox.ts", source: toolbox },
    ...Array.from(
      { length: 9 },
      (_, index) => ({ filePath: `features/extra/widget-${index}.ts`, source: "export const value = 1;\n" }),
    ),
  ];
  const changes: SourceFile[] = [{
    filePath: "features/worker/run.ts",
    source: ownerSource,
    oldSource: balanced,
    changedLines: [{ start: 1, end: 1 }],
  }];
  return { files, changes };
}

describe("import use skew evidence", () => {
  it("reports per-source used-versus-imported ratios with the heaviest edge", () => {
    const { files, changes } = repo(skewed);

    const evidence = buildImportUseSkewEvidence(moduleCandidate("features/worker/run.ts"), files, changes);

    expect(evidence?.sources).toEqual([{
      specifier: "./toolbox.js",
      resolved: "features/worker/toolbox.ts",
      imported: ["format", "parse", "serialize", "validate"],
      used: ["format"],
      unused: ["parse", "serialize", "validate"],
      ratio: 0.25,
    }]);
    expect(evidence?.heaviest).toMatchObject({
      specifier: "./toolbox.js",
      ratio: 0.25,
    });
  });

  it("abstains when every import is exercised", () => {
    const { files, changes } = repo(balanced);
    expect(buildImportUseSkewEvidence(moduleCandidate("features/worker/run.ts"), files, changes))
      .toBeUndefined();
  });

  it("abstains for barrel re-export files", () => {
    const { files, changes } = repo(barrel);
    expect(buildImportUseSkewEvidence(moduleCandidate("features/worker/run.ts"), files, changes))
      .toBeUndefined();
  });
});
