import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildHiddenLoopExitEvidence } from "../src/evidence/hidden-loop-exit.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `export function drain(queue: string[]) {
  while (true) {
    const next = queue.shift();
    if (next === undefined || next.startsWith("#") && next.length > 40) {
      break;
    }
    process(next);
  }
}
`;

const searchAndStop = `export function findUser(users: { id: string }[], id: string) {
  for (const user of users) {
    if (user.id === id) break;
  }
  return null;
}
`;

const switchBreak = `export function classify(code: number) {
  let label = "other";
  for (const rule of rules) {
    switch (rule.kind) {
      case code:
        label = rule.name;
        break;
      default:
        break;
    }
  }
  return label;
}
`;

function project(source: string, extra: ProjectFile[] = []) {
  const filePath = "src/loops.ts";
  return { files: [{ filePath, source }, ...extra], filePath };
}

function candidateFor(source: string, marker: string) {
  const candidate = extractCandidates("src/loops.ts", source)
    .find(({ source: text }) => text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("hidden loop exit evidence", () => {
  it("captures a compound mid-body break under an unbounded header", () => {
    const { files } = project(smelly);
    const evidence = buildHiddenLoopExitEvidence(candidateFor(smelly, "while (true)"), files);

    expect(evidence).toMatchObject({
      function: { name: "drain", exported: true },
      loops: [
        {
          kind: "WhileStatement",
          bounded: false,
          headerCondition: "true",
          exits: [
            {
              kind: "break",
              conditional: true,
              namedPredicate: false,
              duplicatesHeader: false,
            },
          ],
        },
      ],
    });
    expect(evidence?.loops[0]?.exits[0]?.condition).toContain("next");
  });

  it("marks a single search-and-stop exit in a bounded loop", () => {
    const { files } = project(searchAndStop);
    const evidence = buildHiddenLoopExitEvidence(candidateFor(searchAndStop, "for (const user"), files);

    expect(evidence).toMatchObject({
      function: { name: "findUser" },
      loops: [{ kind: "ForOfStatement", bounded: true, exits: [{ kind: "break", conditional: true }] }],
    });
  });

  it("abstains when the loop has no mid-body exit", () => {
    const source = `export function total(items: number[]) {
      let sum = 0;
      for (const item of items) {
        sum += item;
      }
      return sum;
    }`;
    const { files } = project(source);
    expect(buildHiddenLoopExitEvidence(candidateFor(source, "sum +="), files)).toBeUndefined();
  });

  it("does not mistake switch-case breaks for loop exits", () => {
    const { files } = project(switchBreak, [{
      filePath: "src/rules.ts",
      source: "export const rules: { kind: number; name: string }[] = [];",
    }]);
    const evidence = buildHiddenLoopExitEvidence(candidateFor(switchBreak, "switch (rule"), files);
    // The only breaks belong to the switch; the loop itself has no exit.
    expect(evidence).toBeUndefined();
  });

  it("captures a conditional mid-loop return as an exit", () => {
    const source = `export function firstPositive(items: number[]) {
      for (const item of items) {
        if (item > 0) return item;
      }
      return 0;
    }`;
    const { files } = project(source);
    const evidence = buildHiddenLoopExitEvidence(candidateFor(source, "return item"), files);
    expect(evidence?.loops[0]?.exits).toMatchObject([{ kind: "return", conditional: true }]);
  });

  it("includes repository callers for partial-iteration sensitivity", () => {
    const { files } = project(smelly, [{
      filePath: "src/worker.ts",
      source: `import { drain } from "./loops";\nexport function run(q: string[]) { drain(q); }`,
    }]);
    const evidence = buildHiddenLoopExitEvidence(candidateFor(smelly, "while (true)"), files);
    expect(evidence?.callers).toMatchObject([{ filePath: "src/worker.ts", call: "drain(q)" }]);
  });
});
