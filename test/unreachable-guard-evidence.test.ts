import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildUnreachableGuardEvidence } from "../src/evidence/unreachable-guard.js";
import type { ProjectFile } from "../src/types.js";

function files(ownerSource: string, extra: ProjectFile[] = []): ProjectFile[] {
  return [{ filePath: "src/render.ts", source: ownerSource }, ...extra];
}

function changedFunction(ownerSource: string, extra: ProjectFile[] = []) {
  const projectFiles = files(ownerSource, extra);
  const candidate = extractCandidates("src/render.ts", ownerSource)
    .find(({ kind }) => kind === "function");
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no function candidate.");
  return { candidate, projectFiles };
}

describe("unreachable guard evidence", () => {
  it("reports a nullish guard with caller argument shapes", () => {
    const { candidate, projectFiles } = changedFunction(
      "function render(opts: { title: string }): string {\n"
      + "  if (!opts) return \"\";\n"
      + "  return opts.title;\n"
      + "}\n"
      + "export function page(): string {\n"
      + "  return render({ title: \"home\" });\n"
      + "}\n",
    );

    const evidence = buildUnreachableGuardEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "render", parameters: ["opts"] },
      guards: [
        { guardedParameter: "opts", parameterIndex: 0, fallback: "return \"\";" },
      ],
      callers: [{ arguments: ["{ title: \"home\" }"] }],
    });
  });

  it("reports typeof guards over parameters", () => {
    const { candidate, projectFiles } = changedFunction(
      "export function total(values: number[]): number {\n"
      + "  if (typeof values === \"undefined\") throw new Error(\"missing\");\n"
      + "  return values.length;\n"
      + "}\n",
    );

    expect(buildUnreachableGuardEvidence(candidate, projectFiles)).toMatchObject({
      guards: [{ guardKind: "typeof", guardedParameter: "values" }],
    });
  });

  it("abstains when the function has no parameter guard", () => {
    const { candidate, projectFiles } = changedFunction(
      "export function total(values: number[]): number {\n"
      + "  if (values.length === 0) return 0;\n"
      + "  return values.length;\n"
      + "}\n",
    );

    expect(buildUnreachableGuardEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
