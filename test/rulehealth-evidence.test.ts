import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { analyzeAuditWithFailures } from "../src/analyze.js";
import { loadConfig } from "../src/config.js";
import {
  buildMissingAbstentionEvidence,
  buildUnboundedEvidence,
  buildUnfalsifiableEvidence,
} from "../src/rulehealth/plugin.js";
import type {
  Candidate,
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  ProjectFile,
} from "../src/types.js";

class FixedEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];

  constructor(private readonly score = 0.7) {}

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, this.score]));
  }
}

function moduleCandidate(filePath: string): Candidate {
  return {
    id: "module_0",
    kind: "module",
    filePath,
    source: "",
    start: 0,
    end: 0,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  };
}

function project(files: Record<string, string>): ProjectFile[] {
  return Object.entries(files).map(([filePath, source]) => ({ filePath, source }));
}

const RAW_LOOP_BUILDER = `import type { Candidate, ProjectFile } from "../../src/types.js";

export function buildShinyWidgetEvidence(candidate: Candidate, projectFiles: ProjectFile[]) {
  const hits: string[] = [];
  for (const file of projectFiles) {
    if (file.source.includes("widget")) {
      hits.push(file.source.slice(0, 400));
    }
  }
  if (hits.length === 0) return undefined;
  return { filePath: candidate.filePath, hits };
}
`;

const CAPPED_BUILDER = `import type { Candidate, ProjectFile } from "../../src/types.js";

const MAX_WIDGETS = 8;

export function buildPlainGadgetEvidence(candidate: Candidate, projectFiles: ProjectFile[]) {
  const hits: string[] = [];
  for (const file of projectFiles) {
    if (hits.length >= MAX_WIDGETS) break;
    if (file.source.includes("gadget")) hits.push(file.filePath);
  }
  if (hits.length === 0) return undefined;
  return { hits: hits.slice(0, MAX_WIDGETS) };
}
`;

const LOOKUP_BUILDER = `import type { Candidate, ProjectFile } from "../../src/types.js";

export function buildNarrowScopeEvidence(candidate: Candidate, projectFiles: ProjectFile[]) {
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (owner === undefined) return undefined;
  return { filePath: owner.filePath, length: owner.source.length };
}
`;

const ALWAYS_BUILDER = `import type { Candidate } from "../../src/types.js";

export function buildAlwaysEvidence(candidate: Candidate) {
  return { filePath: candidate.filePath, present: true };
}
`;

const SUPPORT_SOURCE = `export function parseCached(path: string, source: string) {
  return { path, length: source.length };
}
`;

const DISPATCH_SOURCE = `export function buildRuleEvidence(ruleId: string) {
  return ruleId;
}
`;

function defaultsWith(entries: string): string {
  return `export const defaultConfig = {
  rules: {
${entries}
  },
};
`;
}

const HEALTHY_ENTRY = `    "jev/no-shiny-widget": {
      scope: "module",
      question: {
        instructions: {
          question: "Does this module create a widget without registering it in the widget catalog used for later lookup?",
          inspect: "Read the module source and the catalog carried in the supplied evidence.",
          focus: "Judge whether a widget is created but never registered where lookups expect it.",
        },
        criteria: {
          true: { what: "A widget is created and never registered" },
          false: { what: "Every created widget is registered" },
        },
      },
      message: "This module creates a widget without registering it.",
    },`;

const NO_CRITERIA_ENTRY = `    "jev/no-shiny-widget": {
      scope: "module",
      question: {
        instructions: {
          question: "Does this module create a widget without registering it in the widget catalog used for later lookup?",
          inspect: "Read the module source and the catalog carried in the supplied evidence.",
          focus: "Judge whether a widget is created but never registered where lookups expect it.",
        },
      },
      message: "This module creates a widget without registering it.",
    },`;

const CROSS_REFERENCING_ENTRY = `    "jev/no-shiny-widget": {
      scope: "module",
      question: {
        instructions: {
          question: "Does this module create a widget without registering it in the widget catalog used for later lookup?",
          inspect: "Read the module source and the catalog carried in the supplied evidence.",
          focus: "Judge whether a widget is created but never registered where lookups expect it.",
          decision_boundary: [
            "jev/no-plain-gadget scores gadget registration in general; this rule scores widgets.",
            "If registration cannot be established, answer no.",
          ],
        },
        criteria: {
          true: { what: "A widget is created and never registered" },
          false: { what: "Every created widget is registered" },
        },
      },
      message: "This module creates a widget without registering it.",
    },`;

const VACUOUS_ENTRY = `    "jev/no-shiny-widget": {
      scope: "module",
      question: {
        instructions: {
          question: "Does it widget?",
          inspect: "Look at the evidence.",
          focus: "",
        },
        criteria: {
          true: { what: "It widgets" },
          false: { what: "It does not widget" },
        },
      },
      message: "It widgets.",
    },`;

describe("rulehealth/no-unbounded-evidence", () => {
  it("abstains outside the rule corpus", () => {
    const files = project({ "src/cli.ts": RAW_LOOP_BUILDER });
    expect(buildUnboundedEvidence(moduleCandidate("src/cli.ts"), files, [])).toBeUndefined();
  });

  it("abstains for support files with no builder export", () => {
    const files = project({ "src/evidence/repository.ts": SUPPORT_SOURCE });
    expect(
      buildUnboundedEvidence(moduleCandidate("src/evidence/repository.ts"), files, []),
    ).toBeUndefined();
  });

  it("abstains when the builder reads only its own candidate", () => {
    const files = project({ "src/evidence/narrow-scope.ts": LOOKUP_BUILDER });
    expect(
      buildUnboundedEvidence(moduleCandidate("src/evidence/narrow-scope.ts"), files, []),
    ).toBeUndefined();
  });

  it("abstains when a named cap bounds the collection", () => {
    const files = project({ "src/evidence/plain-gadget.ts": CAPPED_BUILDER });
    expect(
      buildUnboundedEvidence(moduleCandidate("src/evidence/plain-gadget.ts"), files, []),
    ).toBeUndefined();
  });

  it("fires with named evidence on an uncapped sweep", () => {
    const files = project({ "src/evidence/shiny-widget.ts": RAW_LOOP_BUILDER });
    const evidence = buildUnboundedEvidence(
      moduleCandidate("src/evidence/shiny-widget.ts"),
      files,
      [],
    );
    expect(evidence).toMatchObject({
      rule: "jev/no-shiny-widget",
      filePath: "src/evidence/shiny-widget.ts",
      access: "raw projectFiles iteration",
      capFound: false,
    });
    expect(evidence).toHaveProperty("scanLines");
    expect(evidence).toHaveProperty("scanCount", 1);
  });
  it("abstains for the generated dispatch glue", () => {
    const files = project({ "src/evidence/index.ts": DISPATCH_SOURCE });
    expect(
      buildUnboundedEvidence(moduleCandidate("src/evidence/index.ts"), files, []),
    ).toBeUndefined();
    expect(
      buildMissingAbstentionEvidence(moduleCandidate("src/evidence/index.ts"), files, []),
    ).toBeUndefined();
  });
});

describe("rulehealth/no-missing-abstention", () => {
  it("abstains when the builder can return without evidence", () => {
    const files = project({ "src/evidence/shiny-widget.ts": RAW_LOOP_BUILDER });
    expect(
      buildMissingAbstentionEvidence(moduleCandidate("src/evidence/shiny-widget.ts"), files, []),
    ).toBeUndefined();
  });

  it("abstains outside the rule corpus", () => {
    const files = project({ "src/cli.ts": ALWAYS_BUILDER });
    expect(buildMissingAbstentionEvidence(moduleCandidate("src/cli.ts"), files, [])).toBeUndefined();
  });

  it("fires with named evidence when the builder always answers", () => {
    const files = project({ "src/evidence/always-on.ts": ALWAYS_BUILDER });
    expect(
      buildMissingAbstentionEvidence(moduleCandidate("src/evidence/always-on.ts"), files, []),
    ).toMatchObject({
      rule: "jev/no-always-on",
      filePath: "src/evidence/always-on.ts",
      returnsUndefined: false,
    });
  });
});

describe("rulehealth/no-unfalsifiable-proposition", () => {
  function filesWithDefaults(builderSource: string, entries: string): ProjectFile[] {
    return project({
      "src/evidence/shiny-widget.ts": builderSource,
      "src/defaults.ts": defaultsWith(entries),
    });
  }

  it("abstains on a question with an observation and answer conditions", () => {
    const files = filesWithDefaults(RAW_LOOP_BUILDER, HEALTHY_ENTRY);
    expect(
      buildUnfalsifiableEvidence(moduleCandidate("src/evidence/shiny-widget.ts"), files, []),
    ).toBeUndefined();
  });

  it("abstains when the proposition source is unavailable", () => {
    const files = project({ "src/evidence/shiny-widget.ts": RAW_LOOP_BUILDER });
    expect(
      buildUnfalsifiableEvidence(moduleCandidate("src/evidence/shiny-widget.ts"), files, []),
    ).toBeUndefined();
  });

  it("abstains for the proposition file itself", () => {
    const files = filesWithDefaults(RAW_LOOP_BUILDER, HEALTHY_ENTRY);
    expect(
      buildUnfalsifiableEvidence(moduleCandidate("src/defaults.ts"), files, []),
    ).toBeUndefined();
  });

  it("reads past cross-references to other rules inside the entry", () => {
    const files = filesWithDefaults(RAW_LOOP_BUILDER, CROSS_REFERENCING_ENTRY);
    expect(
      buildUnfalsifiableEvidence(moduleCandidate("src/evidence/shiny-widget.ts"), files, []),
    ).toBeUndefined();
  });

  it("fires when the entry states no answer conditions", () => {
    const files = filesWithDefaults(RAW_LOOP_BUILDER, NO_CRITERIA_ENTRY);
    expect(
      buildUnfalsifiableEvidence(moduleCandidate("src/evidence/shiny-widget.ts"), files, []),
    ).toMatchObject({
      rule: "jev/no-shiny-widget",
      proposition: "jev/no-shiny-widget",
      flaw: "missing-answer-conditions",
      hasCriteria: false,
    });
  });

  it("fires on a question too short to name an observation", () => {
    const files = filesWithDefaults(RAW_LOOP_BUILDER, VACUOUS_ENTRY);
    expect(
      buildUnfalsifiableEvidence(moduleCandidate("src/evidence/shiny-widget.ts"), files, []),
    ).toMatchObject({
      rule: "jev/no-shiny-widget",
      flaw: "vacuous-question",
      hasCriteria: true,
    });
  });
});

describe("rulehealth wiring", () => {
  it("registers the plugin rules in this repo's own config", async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    const config = await loadConfig({ cwd: root });

    for (const key of [
      "rulehealth/no-unbounded-evidence",
      "rulehealth/no-missing-abstention",
      "rulehealth/no-unfalsifiable-proposition",
    ]) {
      expect(config.rules[key]?.scope).toBe("module");
      expect(config.customEvidence?.[key] instanceof Function).toBe(true);
    }
  });

  it("carries a flagged corpus file through audit with the evaluator's raw score", async () => {
    const config: JevLintConfig = {
      rules: {
        "rulehealth/no-unbounded-evidence": {
          scope: "module",
          category: "maintainability",
          question: { instructions: "Does this builder sweep without a cap?" },
          message: "Uncapped sweep.",
        },
        "rulehealth/no-missing-abstention": {
          scope: "module",
          category: "maintainability",
          question: { instructions: "Can this builder return without evidence?" },
          message: "Never abstains.",
        },
        "rulehealth/no-unfalsifiable-proposition": {
          scope: "module",
          category: "maintainability",
          question: { instructions: "Does this question name a checkable observation?" },
          message: "Uncheckable question.",
        },
      },
      customEvidence: {
        "rulehealth/no-unbounded-evidence": buildUnboundedEvidence,
        "rulehealth/no-missing-abstention": buildMissingAbstentionEvidence,
        "rulehealth/no-unfalsifiable-proposition": buildUnfalsifiableEvidence,
      },
    };
    const files = project({
      "src/evidence/shiny-widget.ts": RAW_LOOP_BUILDER,
      "src/evidence/plain-gadget.ts": CAPPED_BUILDER,
      "src/defaults.ts": defaultsWith(`${HEALTHY_ENTRY}\n${HEALTHY_ENTRY.replaceAll("shiny-widget", "plain-gadget")}`),
    });

    const evaluator = new FixedEvaluator(0.7);
    const result = await analyzeAuditWithFailures({ projectFiles: files, config }, evaluator);

    const flagged = result.judgments.filter(
      (judgment) =>
        judgment.ruleId === "rulehealth/no-unbounded-evidence"
        && judgment.filePath === "src/evidence/shiny-widget.ts",
    );
    expect(flagged.length).toBe(1);
    expect(flagged[0]?.probability).toBe(0.7);
    expect(flagged[0]?.evidence).toMatchObject({ rule: "jev/no-shiny-widget", capFound: false });
    expect(
      result.judgments.filter((judgment) => judgment.filePath === "src/evidence/plain-gadget.ts"),
    ).toEqual([]);
  });
});
