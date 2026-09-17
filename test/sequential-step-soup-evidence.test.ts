import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildSequentialStepSoupEvidence } from "../src/evidence/sequential-step-soup.js";
import type { ProjectFile } from "../src/types.js";

const soupSource = `export function runJob(config: Config): void {
  const errors = validateConfig(config);
  if (errors.length > 0) throw new Error(errors.join(","));

  const started = Date.now();
  emitMetric("job.start", started);
  notifyWatchers(config.id);

  const output = renderReport(config);
  writeFileSync(config.outPath, output);
  markComplete(config.id);
}
`;

const callerSource = `import { runJob } from "./job.js";

export function runNightly(config: Config): void {
  runJob(config);
}
`;

const twoPhaseSource = `export function greet(name: string): string {
  const trimmed = name.trim();

  return "hello " + trimmed;
}
`;

function candidate(source: string, filePath: string) {
  return extractCandidates(filePath, source).find(({ kind }) => kind === "function");
}

describe("sequential step soup evidence", () => {
  it("extracts disjoint phases with callers", () => {
    const files: ProjectFile[] = [
      { filePath: "src/job.ts", source: soupSource },
      { filePath: "src/nightly.ts", source: callerSource },
    ];
    const fn = candidate(soupSource, "src/job.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    const evidence = buildSequentialStepSoupEvidence(fn, files);

    expect(evidence).toMatchObject({
      function: { name: "runJob", filePath: "src/job.ts" },
      sharedBindings: [],
      callers: [expect.objectContaining({
        filePath: "src/nightly.ts",
        call: expect.stringContaining("runJob("),
      })],
    });
    expect(evidence?.phases).toHaveLength(3);
    expect(evidence?.phases.every((phase) => phase.coherent)).toBe(true);
  });

  it("reports bindings shared between phases", () => {
    const source = `export function processItems(items: string[]): string[] {
      const cleaned = items.map((item) => item.trim());

      const filtered = cleaned.filter((item) => item.length > 0);
      logCount(filtered.length);

      const saved = persistAll(filtered);
      return saved;
    }
    `;
    const fn = candidate(source, "src/process.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    const evidence = buildSequentialStepSoupEvidence(fn, [{ filePath: "src/process.ts", source }]);
    expect(evidence?.sharedBindings).toContain("cleaned");
  });

  it("abstains for fewer than three phases", () => {
    const fn = candidate(twoPhaseSource, "src/greet.ts");
    expect(fn).toBeDefined();
    if (!fn) return;

    expect(buildSequentialStepSoupEvidence(fn, [{ filePath: "src/greet.ts", source: twoPhaseSource }])).toBeUndefined();
  });
});
