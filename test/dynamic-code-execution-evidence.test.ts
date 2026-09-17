import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildDynamicCodeExecutionEvidence } from "../src/evidence/dynamic-code-execution.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `export function renderTransform(transformBody: string) {
  return eval(transformBody);
}
`;

const literalHelper = `export function doubleIt() {
  const fn = new Function("x", "return x * 2");
  return (fn as (x: number) => number)(21);
}
`;

const vmConstant = `import vm from "node:vm";
const POLICY = "score * 2";
export function scorePolicy(score: number) {
  return vm.runInNewContext(POLICY, { score });
}
`;

const oneHop = `export function runSnippet(req: { body: { code: string } }) {
  const code = req.body.code;
  return eval(code);
}
`;

const withRegistry = `const handlers: Record<string, () => number> = {
  double: () => 2,
  triple: () => 3,
};
export function dispatch(kind: string) {
  return eval(kind);
}
`;

const cleaned = `export function renderTransform(transformBody: string) {
  return transformBody.length;
}
`;

function project(source: string, filePath = "src/transform.ts", extra: ProjectFile[] = []) {
  return { files: [{ filePath, source }, ...extra], filePath };
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("dynamic code execution evidence", () => {
  it("traces eval text to a flowing parameter", () => {
    const { files, filePath } = project(smelly);
    const evidence = buildDynamicCodeExecutionEvidence(candidateFor(smelly, filePath, "renderTransform"), files);

    expect(evidence).toMatchObject({
      function: { name: "renderTransform", exported: true, parameters: ["transformBody"] },
      sinks: [{ sink: "eval", sources: [{ kind: "parameter" }] }],
    });
  });

  it("keeps literal-only Function construction visible with literal sources", () => {
    const { files, filePath } = project(literalHelper);
    const evidence = buildDynamicCodeExecutionEvidence(candidateFor(literalHelper, filePath, "doubleIt"), files);

    expect(evidence?.sinks).toMatchObject([{
      sink: "Function",
      sources: [{ kind: "literal" }, { kind: "literal" }],
    }]);
  });

  it("classifies a module constant behind a vm sink", () => {
    const { files, filePath } = project(vmConstant);
    const evidence = buildDynamicCodeExecutionEvidence(candidateFor(vmConstant, filePath, "scorePolicy"), files);

    expect(evidence?.sinks).toMatchObject([{
      sink: "vm",
      sources: [{ kind: "module-constant" }],
    }]);
    expect(evidence?.vmImports).toContain("node:vm");
  });

  it("resolves one hop from a local binding to request input", () => {
    const { files, filePath } = project(oneHop);
    const evidence = buildDynamicCodeExecutionEvidence(candidateFor(oneHop, filePath, "runSnippet"), files);

    expect(evidence?.sinks).toMatchObject([{
      sink: "eval",
      sources: [{ kind: "request-member", expression: "code" }],
    }]);
  });

  it("records a same-module fixed-function registry", () => {
    const { files, filePath } = project(withRegistry);
    const evidence = buildDynamicCodeExecutionEvidence(candidateFor(withRegistry, filePath, "dispatch"), files);

    expect(evidence?.sinks).toMatchObject([{ sink: "eval" }]);
    expect(evidence?.dispatchMaps).toContain("handlers");
  });

  it("abstains when no compilation sink is present", () => {
    const { files, filePath } = project(cleaned);
    expect(buildDynamicCodeExecutionEvidence(candidateFor(cleaned, filePath, "renderTransform"), files))
      .toBeUndefined();
  });

  it("includes callers for sink-reach sensitivity", () => {
    const { files, filePath } = project(smelly, "src/transform.ts", [{
      filePath: "src/routes.ts",
      source: `import { renderTransform } from "./transform";\nexport function post(b: string) { return renderTransform(b); }`,
    }]);
    const evidence = buildDynamicCodeExecutionEvidence(candidateFor(smelly, filePath, "renderTransform"), files);
    expect(evidence?.callers).toMatchObject([{ filePath: "src/routes.ts" }]);
  });
});
