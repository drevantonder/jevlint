import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildSharedMutableDefaultEvidence } from "../src/evidence/shared-mutable-default.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `export function runJob(name: string, opts: { retried?: boolean } = {}) {
  opts.retried = true;
  return { name, ...opts };
}
`;

const cloned = `export function runJob(name: string, opts: { retried?: boolean } = {}) {
  const snapshot = { ...opts };
  opts.retried = true;
  return { name, ...snapshot };
}
`;

const readOnly = `export function runJob(name: string, opts: { retried?: boolean } = {}) {
  return { name, retried: opts.retried ?? false };
}
`;

const callers = `import { runJob } from "./jobs";
export function handle(name: string) {
  return runJob(name);
}
`;

function candidateFor(filePath: string, source: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("shared mutable default evidence", () => {
  it("flags a default object mutated per call with omitting callers", () => {
    const files: ProjectFile[] = [
      { filePath: "src/jobs.ts", source: smelly },
      { filePath: "src/handler.ts", source: callers },
    ];
    const evidence = buildSharedMutableDefaultEvidence(
      candidateFor("src/jobs.ts", smelly, "opts.retried = true"),
      files,
    );

    expect(evidence).toMatchObject({
      function: { name: "runJob" },
      defaults: [{
        name: "opts",
        defaultKind: "object-literal",
        clonedBeforeWrite: false,
        callersOmittingArgument: 1,
      }],
    });
    expect(evidence?.defaults[0]?.writes).toHaveLength(1);
  });

  it("records a defensive copy while still reporting the write", () => {
    const files: ProjectFile[] = [{ filePath: "src/jobs.ts", source: cloned }];
    const evidence = buildSharedMutableDefaultEvidence(
      candidateFor("src/jobs.ts", cloned, "opts.retried = true"),
      files,
    );

    expect(evidence).toMatchObject({
      defaults: [{ name: "opts", clonedBeforeWrite: true }],
    });
  });

  it("abstains when the default is only read", () => {
    const files: ProjectFile[] = [{ filePath: "src/jobs.ts", source: readOnly }];
    const evidence = buildSharedMutableDefaultEvidence(
      candidateFor("src/jobs.ts", readOnly, "opts.retried"),
      files,
    );

    expect(evidence).toBeUndefined();
  });
});
