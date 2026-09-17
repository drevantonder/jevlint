import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildLocaleDateSerializationEvidence } from "../src/evidence/locale-date-serialization.js";

function candidateFor(source: string, marker: string) {
  const candidate = extractCandidates("src/events.ts", source)
    .find(({ source: text }) => text.includes(marker));
  expect(candidate).toBeDefined();
  if (!candidate) throw new Error("fixture candidate missing");
  return candidate;
}

const PERSISTED_LOCALE = `export function persistEvent(when: Date) {
  return db.events.insert({ at: when.toLocaleString() });
}`;

const DISPLAY_LOCALE = `export function formatEvent(when: Date) {
  return when.toLocaleDateString();
}`;

const PERSISTED_ISO = `export function persistEvent(when: Date) {
  return db.events.insert({ at: when.toISOString() });
}`;

describe("locale date serialization evidence", () => {
  it("flags locale-rendered dates flowing into storage", () => {
    const candidate = candidateFor(PERSISTED_LOCALE, "persistEvent");
    const evidence = buildLocaleDateSerializationEvidence(candidate, [
      { filePath: "src/events.ts", source: PERSISTED_LOCALE },
      { filePath: "src/other.ts", source: "export function other(when: Date) { return when.toISOString(); }" },
    ]);
    expect(evidence).toMatchObject({
      function: { name: "persistEvent", exported: true },
      hasBoundarySink: true,
      hasIsoForm: false,
      siblingIsoSerialization: true,
    });
    expect(evidence?.serializations.length).toBeGreaterThan(0);
  });

  it("distinguishes display-only locale rendering from boundary sinks", () => {
    const candidate = candidateFor(DISPLAY_LOCALE, "formatEvent");
    const evidence = buildLocaleDateSerializationEvidence(candidate, [
      { filePath: "src/events.ts", source: DISPLAY_LOCALE },
    ]);
    expect(evidence?.hasBoundarySink).toBe(false);
  });

  it("abstains when dates serialize as ISO", () => {
    const candidate = candidateFor(PERSISTED_ISO, "persistEvent");
    expect(buildLocaleDateSerializationEvidence(candidate, [
      { filePath: "src/events.ts", source: PERSISTED_ISO },
    ])).toBeUndefined();
  });
});
