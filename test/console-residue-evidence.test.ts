import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildConsoleResidueEvidence } from "../src/evidence/console-residue.js";
import type { ProjectFile } from "../src/types.js";

const smelly = `import { logger } from "winston";
export function handleOrder(order: Order) {
  logger.info("handling order");
  console.log(order);
  return fulfill(order);
}
`;

const debuggerOnly = `export function handleOrder(order: Order) {
  debugger;
  return fulfill(order);
}
`;

const operationalError = `export function startServer(port: number) {
  try {
    return listen(port);
  } catch (error) {
    console.error("fatal startup failure", error);
    throw error;
  }
}
`;

const nestedOnly = `export function handleOrder(order: Order) {
  order.items.forEach((item) => console.log(item));
  return fulfill(order);
}
`;

function project(source: string, filePath = "src/orders.ts"): ProjectFile[] {
  return [{ filePath, source }];
}

function candidateFor(source: string, filePath: string, marker: string) {
  const candidate = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(marker));
  expect(candidate).toBeDefined();
  return candidate!;
}

describe("console residue evidence", () => {
  it("captures console output beside an adopted logger", () => {
    const filePath = "src/orders.ts";
    const evidence = buildConsoleResidueEvidence(candidateFor(smelly, filePath, "handleOrder"), project(smelly, filePath));

    expect(evidence).toMatchObject({
      function: { name: "handleOrder", exported: true, testFile: false },
      consoleCalls: [{ method: "log" }],
      loggerImports: ["winston"],
    });
    expect(evidence?.consoleCalls[0]?.expression).toContain("console.log(order)");
  });

  it("captures debugger statements with no console calls", () => {
    const filePath = "src/orders.ts";
    const evidence = buildConsoleResidueEvidence(
      candidateFor(debuggerOnly, filePath, "handleOrder"),
      project(debuggerOnly, filePath),
    );

    expect(evidence?.consoleCalls).toEqual([]);
    expect(evidence?.debuggerStatements).toHaveLength(1);
  });

  it("abstains when only an operational error report remains", () => {
    const filePath = "src/server.ts";
    expect(buildConsoleResidueEvidence(
      candidateFor(operationalError, filePath, "startServer"),
      project(operationalError, filePath),
    )).toBeUndefined();
  });

  it("abstains for test files that own their console", () => {
    const filePath = "src/orders.test.ts";
    expect(buildConsoleResidueEvidence(
      candidateFor(smelly, filePath, "handleOrder"),
      project(smelly, filePath),
    )).toBeUndefined();
  });

  it("ignores console calls hidden inside nested callbacks", () => {
    const filePath = "src/orders.ts";
    expect(buildConsoleResidueEvidence(
      candidateFor(nestedOnly, filePath, "handleOrder"),
      project(nestedOnly, filePath),
    )).toBeUndefined();
  });

  it("includes callers for shipped-path sensitivity", () => {
    const filePath = "src/orders.ts";
    const files: ProjectFile[] = [
      { filePath, source: smelly },
      {
        filePath: "src/route.ts",
        source: `import { handleOrder } from "./orders";\nexport function post(o: never) { return handleOrder(o); }`,
      },
    ];
    const evidence = buildConsoleResidueEvidence(candidateFor(smelly, filePath, "handleOrder"), files);
    expect(evidence?.callers).toMatchObject([{ filePath: "src/route.ts" }]);
  });
});
