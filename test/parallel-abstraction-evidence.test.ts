import { describe, expect, it } from "vitest";
import { extractCandidates } from "../src/candidates.js";
import { buildRuleEvidence } from "../src/evidence/index.js";
import { buildParallelAbstractionEvidence } from "../src/evidence/parallel-abstraction.js";
import type { Candidate, ProjectFile } from "../src/types.js";

const parallel = `export class NotificationService {
  send(message: string) {
    console.log(message);
  }
}
export function sendNotification(message: string) {
  new NotificationService().send(message);
}
`;

const incumbent = `export class EventDispatcher {
  emit(event: string) {
    console.log(event);
  }
}
export function emitNotification(message: string) {
  new EventDispatcher().emit(message);
}
`;

const adapter = `import { emitNotification } from "./events";
export function sendNotification(message: string) {
  emitNotification(message);
}
`;

const defaultOnly = `export default () => {
  console.log("side effect");
};
`;

function candidateFor(source: string, filePath: string, snippet: string): Candidate {
  const found = extractCandidates(filePath, source)
    .find(({ kind, source: text }) => kind === "function" && text.includes(snippet));
  expect(found).toBeDefined();
  expect(found?.kind).toBe("function");
  if (!found) throw new Error("candidate missing");
  return found;
}

describe("parallel abstraction evidence", () => {
  it("connects the new module's concept to the incumbent's vocabulary", () => {
    const projectFiles: ProjectFile[] = [
      { filePath: "src/notify.ts", source: parallel },
      { filePath: "src/events.ts", source: incumbent },
    ];
    const candidate = candidateFor(parallel, "src/notify.ts", "function sendNotification");

    const evidence = buildParallelAbstractionEvidence(candidate, projectFiles);

    expect(evidence).toMatchObject({
      function: { name: "sendNotification", exported: true },
      module: {
        filePath: "src/notify.ts",
        exports: expect.arrayContaining(["NotificationService", "sendNotification"]),
      },
      overlaps: [{
        sibling: "src/events.ts",
        sharedTokens: expect.arrayContaining(["notification"]),
      }],
      delegation: { delegatesTo: [] },
    });
  });

  it("surfaces delegation so the judgment can score low", () => {
    const projectFiles: ProjectFile[] = [
      { filePath: "src/notify.ts", source: adapter },
      { filePath: "src/events.ts", source: incumbent },
    ];
    const candidate = candidateFor(adapter, "src/notify.ts", "function sendNotification");

    const evidence = buildParallelAbstractionEvidence(candidate, projectFiles);

    expect(evidence?.overlaps[0]?.sharedTokens).toContain("notification");
    expect(evidence?.delegation.delegatesTo).toEqual([
      expect.stringContaining("emitNotification"),
    ]);
  });

  it("abstains when the module exposes no named concept", () => {
    const candidates = extractCandidates("src/side-effect.ts", defaultOnly);
    const candidate = candidates.find(({ kind }) => kind === "function");
    expect(candidate?.kind).toBe("function");
    if (!candidate) return;

    expect(buildParallelAbstractionEvidence(candidate, [{ filePath: "src/side-effect.ts", source: defaultOnly }]))
      .toBeUndefined();
  });

  it("abstains for non-function candidates", () => {
    const comment = { ...candidateFor(parallel, "src/notify.ts", "function sendNotification"), kind: "comment" as const };
    expect(buildParallelAbstractionEvidence(comment, [{ filePath: "src/notify.ts", source: parallel }]))
      .toBeUndefined();
  });

  it("dispatches through the rule registry", () => {
    const projectFiles: ProjectFile[] = [
      { filePath: "src/notify.ts", source: parallel },
      { filePath: "src/events.ts", source: incumbent },
    ];
    const candidate = candidateFor(parallel, "src/notify.ts", "function sendNotification");

    const result = buildRuleEvidence("jev/no-parallel-abstraction", candidate, projectFiles);

    expect(result.handled).toBe(true);
    expect(result.handled && result.evidence).toBeDefined();
  });
});
