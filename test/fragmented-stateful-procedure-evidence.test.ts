import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildFragmentedStatefulProcedureEvidence } from "../src/evidence/fragmented-stateful-procedure.js";
import type { Candidate, ProjectFile } from "../src/types.js";

function project(ownerSource: string, extra: ProjectFile[] = []) {
  const projectFiles: ProjectFile[] = [{ filePath: "src/session.ts", source: ownerSource }, ...extra];
  return { projectFiles };
}

function functionCandidate(source: string, marker: string) {
  const { projectFiles } = project(source);
  const candidate = extractCandidates("src/session.ts", source)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes(marker));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no matching function candidate.");
  return { candidate, projectFiles };
}

function entryCandidate(source: string) {
  const { projectFiles } = project(source);
  const candidate = extractCandidates("src/session.ts", source)
    .filter(({ kind }) => kind === "function")
    .find(({ source }) => source.includes("checkout(userId"));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("Fixture has no entry candidate.");
  return { candidate, projectFiles };
}

const SMELLY = "let activeSession: string | null = null;\n"
  + "let cartTotal = 0;\n"
  + "let discountApplied = false;\n"
  + "\n"
  + "function startSession(userId: string): void {\n"
  + "  activeSession = userId;\n"
  + "}\n"
  + "\n"
  + "function loadCartTotal(items: number[]): void {\n"
  + "  cartTotal = items.reduce((sum, item) => sum + item, 0);\n"
  + "}\n"
  + "\n"
  + "function applyLoyaltyDiscount(): void {\n"
  + "  if (activeSession !== null && cartTotal > 100) {\n"
  + "    cartTotal = cartTotal - 10;\n"
  + "    discountApplied = true;\n"
  + "  }\n"
  + "}\n"
  + "\n"
  + "export function checkout(userId: string, items: number[]): number {\n"
  + "  startSession(userId);\n"
  + "  loadCartTotal(items);\n"
  + "  applyLoyaltyDiscount();\n"
  + "  return cartTotal;\n"
  + "}\n";

describe("fragmented stateful procedure evidence", () => {
  it("reports the ordered helpers with shared-state writes and write-then-read edges", () => {
    const { candidate, projectFiles } = entryCandidate(SMELLY);

    const evidence = buildFragmentedStatefulProcedureEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "checkout", exported: true },
      orderedCalls: ["startSession", "loadCartTotal", "applyLoyaltyDiscount"],
      entryOwnStateOperations: [],
    });
    expect(evidence?.helpers.map(({ name }) => name)).toEqual([
      "startSession",
      "loadCartTotal",
      "applyLoyaltyDiscount",
    ]);
    expect(evidence?.helpers.every(({ mutatesOuterState }) => mutatesOuterState)).toBe(true);
    expect(evidence?.helpers.every(({ exported }) => !exported)).toBe(true);
    expect(evidence?.helpers.every(({ callsElsewhere }) => callsElsewhere === 0)).toBe(true);
    expect(evidence?.helpers.find(({ name }) => name === "startSession")).toMatchObject({
      writtenBindings: ["activeSession"],
    });
    expect(evidence?.helpers.find(({ name }) => name === "applyLoyaltyDiscount")).toMatchObject({
      writtenBindings: expect.arrayContaining(["cartTotal", "discountApplied"]),
      readBindings: expect.arrayContaining(["activeSession", "cartTotal"]),
    });
    expect(evidence?.writeReadEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ binding: "activeSession", writer: "startSession", reader: "applyLoyaltyDiscount" }),
        expect.objectContaining({ binding: "cartTotal", writer: "loadCartTotal", reader: "applyLoyaltyDiscount" }),
      ]),
    );
  });

  it("abstains when the entry calls fewer than three same-module helpers", () => {
    const source = "let total = 0;\n"
      + "function add(a: number): void {\n"
      + "  total += a;\n"
      + "}\n"
      + "function reset(): void {\n"
      + "  total = 0;\n"
      + "}\n"
      + "export function run(a: number): number {\n"
      + "  add(a);\n"
      + "  reset();\n"
      + "  return total;\n"
      + "}\n";
    const { candidate, projectFiles } = functionCandidate(source, "run(a");

    expect(buildFragmentedStatefulProcedureEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("abstains when the entry performs no helper calls", () => {
    const source = "export function total(items: number[]): number {\n"
      + "  let sum = 0;\n"
      + "  for (const item of items) sum += item;\n"
      + "  return sum;\n"
      + "}\n";
    const { candidate, projectFiles } = functionCandidate(source, "total(items");

    expect(buildFragmentedStatefulProcedureEvidence(candidate, projectFiles)).toBeUndefined();
  });

  it("returns evidence without mutations for pure helpers so the judgment scores low", () => {
    const source = "function double(n: number): number {\n"
      + "  return n * 2;\n"
      + "}\n"
      + "function inc(n: number): number {\n"
      + "  return n + 1;\n"
      + "}\n"
      + "function square(n: number): number {\n"
      + "  return n * n;\n"
      + "}\n"
      + "export function pipeline(n: number): number {\n"
      + "  const a = double(n);\n"
      + "  const b = inc(a);\n"
      + "  return square(b);\n"
      + "}\n";
    const { candidate, projectFiles } = functionCandidate(source, "pipeline(n");

    const evidence = buildFragmentedStatefulProcedureEvidence(candidate, projectFiles);

    expect(evidence?.orderedCalls).toEqual(["double", "inc", "square"]);
    expect(evidence?.helpers.every(({ mutatesOuterState }) => !mutatesOuterState)).toBe(true);
    expect(evidence?.writeReadEdges).toEqual([]);
  });

  it("counts callers outside the entry instead of abstaining", () => {
    const { projectFiles } = project(SMELLY, [{
      filePath: "src/other.ts",
      source: "import { checkout } from \"./session.js\";\n"
        + "export function rerun(): number {\n"
        + "  return checkout(\"ana\", [5]);\n"
        + "}\n",
    }]);
    const candidate = extractCandidates("src/session.ts", SMELLY)
      .filter(({ kind }) => kind === "function")
      .find(({ source }) => source.includes("checkout(userId"));
    expect(candidate).toBeDefined();
    if (!candidate) throw new Error("Fixture has no entry candidate.");

    const evidence = buildFragmentedStatefulProcedureEvidence(candidate, projectFiles);

    expect(evidence?.function.name).toBe("checkout");
    expect(evidence?.callers.length).toBeGreaterThan(0);
  });

  it("flags helpers with callers outside the entry", () => {
    const source = SMELLY
      + "\n"
      + "export function warmup(userId: string): void {\n"
      + "  startSession(userId);\n"
      + "}\n";
    const { candidate, projectFiles } = entryCandidate(source);

    const evidence = buildFragmentedStatefulProcedureEvidence(candidate, projectFiles);

    expect(evidence?.helpers.find(({ name }) => name === "startSession")).toMatchObject({
      callsElsewhere: 1,
    });
    expect(evidence?.helpers.find(({ name }) => name === "loadCartTotal")).toMatchObject({
      callsElsewhere: 0,
    });
  });

  it("marks exported helpers as documented seams", () => {
    const source = SMELLY.replace(
      "function startSession(userId: string): void {",
      "export function startSession(userId: string): void {",
    );
    const { candidate, projectFiles } = entryCandidate(source);

    const evidence = buildFragmentedStatefulProcedureEvidence(candidate, projectFiles);

    expect(evidence?.helpers.find(({ name }) => name === "startSession")).toMatchObject({
      exported: true,
    });
  });

  it("records state logic the entry interleaves between helper calls", () => {
    const source = SMELLY.replace(
      "  loadCartTotal(items);\n",
      "  loadCartTotal(items);\n  cartTotal += items.length;\n",
    );
    const { candidate, projectFiles } = entryCandidate(source);

    const evidence = buildFragmentedStatefulProcedureEvidence(candidate, projectFiles);

    expect(evidence?.entryOwnStateOperations).toEqual(
      expect.arrayContaining([expect.stringContaining("cartTotal +=")]),
    );
  });

  it("abstains for non-function candidates", () => {
    const { projectFiles } = project(SMELLY);
    const candidate: Candidate = {
      id: "src/session.ts:comment",
      kind: "comment",
      filePath: "src/session.ts",
      source: "// session",
      start: 0,
      end: 10,
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 11,
    };

    expect(buildFragmentedStatefulProcedureEvidence(candidate, projectFiles)).toBeUndefined();
  });
});
