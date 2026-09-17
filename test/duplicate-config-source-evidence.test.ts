import { describe, expect, it } from "vitest";
import { buildDuplicateConfigSourceEvidence } from "../src/evidence/duplicate-config-source.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

const ownedConfig: ProjectFile = {
  filePath: "src/config/index.ts",
  source: `export const config = { stripeKey: process.env.STRIPE_KEY ?? "" };
`,
};

const siblingA: ProjectFile = {
  filePath: "src/billing.ts",
  source: `import { config } from "./config";
export function charge() {
  return config.stripeKey;
}
`,
};

const siblingB: ProjectFile = {
  filePath: "src/refunds.ts",
  source: `import { config } from "./config";
export function refund() {
  return config.stripeKey;
}
`,
};

const afterBypass = `export function notify() {
  const key = process.env.NOTIFY_KEY;
  return send(key);
}
`;

const beforeBypass = `export function notify() {
  return send("none");
}
`;

const afterDelegating = `import { config } from "./config";
import dotenv from "dotenv";
dotenv.config();
export function notify() {
  return send(config.stripeKey);
}
`;

function candidate(filePath: string): Candidate {
  return {
    id: "change_0",
    kind: "change",
    filePath,
    source: "Whole change. Use the rule-specific before/after evidence.",
    start: 0,
    end: 1,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  };
}

type ChangeScenario = {
  changes: SourceFile[];
  projectFiles: ProjectFile[];
};

function scenario(after: string, before: string | null): ChangeScenario {
  const changes: SourceFile[] = [{
    filePath: "src/notify.ts",
    source: after,
    oldSource: before,
    changedLines: [{ start: 1, end: 4 }],
  }];
  const projectFiles: ProjectFile[] = [
    ownedConfig,
    siblingA,
    siblingB,
    { filePath: "src/notify.ts", source: after },
  ];
  return { changes, projectFiles };
}

describe("duplicate config source evidence", () => {
  it("extracts a fresh env read bypassing the owned module", () => {
    const { changes, projectFiles } = scenario(afterBypass, beforeBypass);
    const evidence = buildDuplicateConfigSourceEvidence(
      candidate("src/notify.ts"),
      changes,
      projectFiles,
    );

    expect(evidence).toMatchObject({
      ownedModule: { filePath: "src/config/index.ts" },
      delegatesToOwned: false,
    });
    expect(evidence?.newReads.map(({ kind }) => kind)).toContain("env-read");
    expect(evidence?.ownedChannelUsers).toBe(2);
  });

  it("marks delegation when the new channel imports the owned module", () => {
    const { changes, projectFiles } = scenario(afterDelegating, beforeBypass);
    const evidence = buildDuplicateConfigSourceEvidence(
      candidate("src/notify.ts"),
      changes,
      projectFiles,
    );

    expect(evidence).toMatchObject({ delegatesToOwned: true });
    expect(evidence?.newReads.map(({ kind }) => kind)).toContain("dotenv-init");
  });

  it("abstains when no owned module exists", () => {
    const changes: SourceFile[] = [{
      filePath: "src/notify.ts",
      source: afterBypass,
      oldSource: beforeBypass,
      changedLines: [{ start: 1, end: 4 }],
    }];
    expect(buildDuplicateConfigSourceEvidence(
      candidate("src/notify.ts"),
      changes,
      [{ filePath: "src/notify.ts", source: afterBypass }],
    )).toBeUndefined();
  });
});
