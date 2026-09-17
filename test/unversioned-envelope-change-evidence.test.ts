import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { buildUnversionedEnvelopeChangeEvidence } from "../src/evidence/unversioned-envelope-change.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import type { Candidate, ProjectFile, SourceFile } from "../src/types.js";

const root = new URL("./fixtures/repositories/unversioned-envelope-change-smelly/", import.meta.url);

async function load(filePath: string): Promise<ProjectFile> {
  return { filePath, source: await readFile(new URL(filePath, root), "utf8") };
}

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

describe("unversioned envelope change evidence", () => {
  it("diffs a required addition against the old source with consumer reach", async () => {
    const [afterFile, consumer] = await Promise.all([
      load("src/order-event.after.ts"),
      load("src/checkout.ts"),
    ]);
    const before = await readFile(new URL("src/order-event.before.ts", root), "utf8");
    const filePath = "src/order-event.ts";
    const projectFiles = [
      { filePath, source: afterFile.source },
      { filePath: consumer.filePath, source: consumer.source },
    ];
    const changes: SourceFile[] = [{
      filePath,
      source: afterFile.source,
      oldSource: before,
      changedLines: [{ start: 1, end: 6 }],
    }];

    const evidence = buildUnversionedEnvelopeChangeEvidence(
      candidate(filePath),
      changes,
      projectFiles,
    );

    expect(evidence?.anchorFile).toBe(filePath);
    expect(evidence?.envelopeBreaks).toHaveLength(1);
    expect(evidence?.envelopeBreaks[0]).toMatchObject({
      typeName: "OrderEvent",
      kind: "interface",
      envelopeLike: true,
      versionField: null,
      kindDiscriminator: null,
      compatibilityShim: false,
    });
    expect(evidence?.envelopeBreaks[0]?.memberChanges).toContainEqual(
      expect.objectContaining({ member: "currency", kind: "added-required" }),
    );
    expect(evidence?.envelopeBreaks[0]?.memberChanges).toContainEqual(
      expect.objectContaining({ member: "couponCode", kind: "added-optional" }),
    );
    expect(evidence?.envelopeBreaks[0]?.consumers.map(({ filePath: path }) => path))
      .toContain("src/checkout.ts");
  });

  it("abstains when the member set is unchanged", async () => {
    const before = await readFile(new URL("src/order-event.before.ts", root), "utf8");
    const filePath = "src/order-event.ts";
    const projectFiles = [{ filePath, source: before }];
    const changes: SourceFile[] = [{
      filePath,
      source: before,
      oldSource: before,
      changedLines: [{ start: 1, end: 4 }],
    }];

    expect(buildUnversionedEnvelopeChangeEvidence(candidate(filePath), changes, projectFiles))
      .toBeUndefined();
  });

  it("dispatches through the rule registry", async () => {
    const [afterFile, consumer] = await Promise.all([
      load("src/order-event.after.ts"),
      load("src/checkout.ts"),
    ]);
    const before = await readFile(new URL("src/order-event.before.ts", root), "utf8");
    const filePath = "src/order-event.ts";
    const projectFiles = [
      { filePath, source: afterFile.source },
      { filePath: consumer.filePath, source: consumer.source },
    ];
    const changes: SourceFile[] = [{
      filePath,
      source: afterFile.source,
      oldSource: before,
      changedLines: [{ start: 1, end: 6 }],
    }];

    const result = buildRuleEvidence(
      "jev/no-unversioned-envelope-change",
      candidate(filePath),
      projectFiles,
      changes,
    );

    expect(result.handled).toBe(true);
    expect(result.handled && result.evidence).toBeDefined();
  });
});
