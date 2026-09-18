import { describe, expect, it } from "vitest";
import { analyzeFile } from "../../src/analyze.js";
import { defaultConfig } from "../../src/config.js";
import { TypeSafeEvaluator } from "../../src/typesafe-evaluator.js";
import type { Evaluator, JevLintConfig, ProjectFile } from "../../src/types.js";

const liveDescribe = process.env.RUN_LIVE_JEV === "1" ? describe : describe.skip;

class PassthroughEvaluator implements Evaluator {
  readonly delegate = new TypeSafeEvaluator({ apiKey: process.env.TYPESAFE_API_KEY ?? "" });
  evaluate(request: Parameters<Evaluator["evaluate"]>[0]) {
    return this.delegate.evaluate(request);
  }
}

const smelly: ProjectFile[] = [
  {
    filePath: "src/billing.ts",
    source: `export interface Invoice {
  number: string;
  total: number;
  dueDate: string;
}
`,
  },
  {
    filePath: "src/shipping.ts",
    source: `export interface Invoice {
  trackingId: string;
  carrier: string;
  weightKg: number;
}
`,
  },
  {
    filePath: "src/app.ts",
    source: `import type { Invoice as BillingInvoice } from "./billing";
import type { Invoice as ShippingInvoice } from "./shipping";
export function reconcile(billing: BillingInvoice, shipping: ShippingInvoice): string {
  return billing.number + shipping.trackingId;
}
`,
  },
];

const clean: ProjectFile[] = [
  {
    filePath: "src/billing.ts",
    source: `export interface Invoice {
  number: string;
  total: number;
  dueDate: string;
}
`,
  },
  {
    filePath: "src/shipping.ts",
    source: `export interface Shipment {
  trackingId: string;
  carrier: string;
  weightKg: number;
}
`,
  },
  {
    filePath: "src/app.ts",
    source: `import type { Invoice } from "./billing";
import type { Shipment } from "./shipping";
export function reconcile(billing: Invoice, shipping: Shipment): string {
  return billing.number + shipping.trackingId;
}
`,
  },
];

async function lintChangedFile(projectFiles: ProjectFile[], filePath: string) {
  const changed = projectFiles.find((file) => file.filePath === filePath);
  expect(changed).toBeDefined();
  if (!changed) return [];
  const rule = defaultConfig.rules["jev/no-context-homonym-type"];
  expect(rule).toBeDefined();
  if (!rule) return [];
  const config: JevLintConfig = { rules: { "jev/no-context-homonym-type": rule } };
  return analyzeFile(
    {
      filePath,
      source: changed.source,
      changedLines: [{ start: 1, end: changed.source.split("\n").length }],
      config,
      projectFiles,
    },
    new PassthroughEvaluator(),
  );
}

liveDescribe("context homonym type with name inventory evidence", () => {
  it("flags a shared name with disjoint members but keeps distinct names", async () => {
    const [smellyJudgments, cleanJudgments] = await Promise.all([
      lintChangedFile(smelly, "src/billing.ts"),
      lintChangedFile(clean, "src/billing.ts"),
    ]);

    expect(smellyJudgments.map(({ ruleId }) => ruleId)).toContain(
      "jev/no-context-homonym-type",
    );
    expect(cleanJudgments).toHaveLength(0);
  });
});
