import type { JsonValue } from "@typesafe-ai/sdk";
import type {
  Candidate,
  CustomEvidenceBuilder,
  CustomRuleDescriptor,
  ProjectFile,
} from "../types.js";

export const PLUGIN_NAME = "rulehealth";

const DEFAULTS_PATH = "src/defaults.ts";

const BUILDER_FILE_PATTERN = /^src\/evidence\/[a-z0-9-]+\.ts$/;
const BUILD_EXPORT_PATTERN = /export\s+function\s+(build\w*Evidence)/g;
/** The shared dispatch wrapper in the generated registry glue: not a rule builder. */
const DISPATCH_BUILDER = "buildRuleEvidence";
const RAW_SCAN_PATTERN = /\bof\s+projectFiles\b|projectFiles\s*\.\s*(map|flatMap|filter|forEach|reduce)\s*\(/;
const NAMED_CAP_PATTERN = /const\s+MAX_[A-Z0-9_]+\s*(:\s*number\s*)?=\s*\d+/;
const COUNT_SLICE_PATTERN = /\.slice\(\s*0\s*,\s*([\d_]+)/g;
/** A `.slice(0, n)` bound at or below this size reads as a cap on how many
 * items are collected. Larger bounds in this corpus truncate preview strings,
 * not collections. */
const COUNT_SLICE_LIMIT = 32;
const ABSENT_PATH_PATTERN = /return\s+undefined|\?\?\s*undefined/;
/** A question plus focus shorter than this cannot name both an observation
 * and the context that would refute it. */
const VACUOUS_WORD_FLOOR = 12;

export type UnboundedEvidence = {
  rule: string;
  filePath: string;
  access: string;
  scanLines: number[];
  scanCount: number;
  capFound: boolean;
};

export type MissingAbstention = {
  rule: string;
  filePath: string;
  returnsUndefined: boolean;
};

export type UnfalsifiableProposition = {
  rule: string;
  filePath: string;
  proposition: string;
  flaw: string;
  questionWords: number;
  focusWords: number;
  hasCriteria: boolean;
};

function fileSource(filePath: string, projectFiles: ProjectFile[]): string | undefined {
  const match = projectFiles.find((file) => file.filePath === filePath);
  return match === undefined ? undefined : match.source;
}

/** The builder source for a corpus rule file, or undefined for anything else
 * (support files, generated glue, non-corpus paths). Builders judge only the
 * corpus; every other file abstains by construction. */
function corpusBuilderSource(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): { rule: string; source: string } | undefined {
  if (!BUILDER_FILE_PATTERN.test(candidate.filePath)) return undefined;
  const source = fileSource(candidate.filePath, projectFiles);
  if (source === undefined) return undefined;
  BUILD_EXPORT_PATTERN.lastIndex = 0;
  let foundRuleBuilder = false;
  let match = BUILD_EXPORT_PATTERN.exec(source);
  while (match !== null) {
    if (match[1] !== DISPATCH_BUILDER) foundRuleBuilder = true;
    match = BUILD_EXPORT_PATTERN.exec(source);
  }
  if (!foundRuleBuilder) return undefined;
  const stem = candidate.filePath.slice("src/evidence/".length, -".ts".length);
  return { rule: `jev/no-${stem}`, source };
}

function matchLines(source: string, pattern: RegExp): number[] {
  const lines: number[] = [];
  const rows = source.split("\n");
  for (let index = 0; index < rows.length; index += 1) {
    if (pattern.test(rows[index] ?? "")) lines.push(index + 1);
  }
  return lines;
}

function hasCountCap(source: string): boolean {
  if (NAMED_CAP_PATTERN.test(source)) return true;
  if (source.includes("projectFiles.slice")) return true;
  COUNT_SLICE_PATTERN.lastIndex = 0;
  let match = COUNT_SLICE_PATTERN.exec(source);
  while (match !== null) {
    const raw = (match[1] ?? "").replace(/_/g, "");
    const bound = Number.parseInt(raw, 10);
    if (Number.isInteger(bound) && bound <= COUNT_SLICE_LIMIT) return true;
    match = COUNT_SLICE_PATTERN.exec(source);
  }
  return false;
}

export const buildUnboundedEvidence: CustomEvidenceBuilder = (
  candidate,
  projectFiles,
): JsonValue | undefined => {
  const corpus = corpusBuilderSource(candidate, projectFiles);
  if (corpus === undefined) return undefined;
  const scans = matchLines(corpus.source, RAW_SCAN_PATTERN);
  if (scans.length === 0) return undefined;
  if (hasCountCap(corpus.source)) return undefined;
  const evidence: UnboundedEvidence = {
    rule: corpus.rule,
    filePath: candidate.filePath,
    access: "raw projectFiles iteration",
    scanLines: scans.slice(0, 3),
    scanCount: scans.length,
    capFound: false,
  };
  return evidence;
};

export const buildMissingAbstentionEvidence: CustomEvidenceBuilder = (
  candidate,
  projectFiles,
): JsonValue | undefined => {
  const corpus = corpusBuilderSource(candidate, projectFiles);
  if (corpus === undefined) return undefined;
  if (ABSENT_PATH_PATTERN.test(corpus.source)) return undefined;
  const evidence: MissingAbstention = {
    rule: corpus.rule,
    filePath: candidate.filePath,
    returnsUndefined: false,
  };
  return evidence;
};

function defaultsEntry(defaultsSource: string, ruleKey: string): string | undefined {
  const marker = `"${ruleKey}": {`;
  const start = defaultsSource.indexOf(marker);
  if (start < 0) return undefined;
  // Walk to the matching close brace so cross-references to other rule keys
  // inside the entry (e.g. in decision boundaries) cannot truncate it.
  let depth = 0;
  let inString: string | undefined;
  let index = start + marker.length - 1;
  while (index < defaultsSource.length && index < start + 40000) {
    const ch = defaultsSource[index];
    if (ch === undefined) break;
    if (inString !== undefined) {
      if (ch === "\\") {
        index += 2;
        continue;
      }
      if (ch === inString) inString = undefined;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return defaultsSource.slice(start, index + 1);
    }
    index += 1;
  }
  return undefined;
}

function firstStringField(entry: string, field: string): string | undefined {
  const marker = `${field}: "`;
  const at = entry.indexOf(marker);
  if (at < 0) return undefined;
  let out = "";
  let index = at + marker.length;
  while (index < entry.length) {
    const ch = entry[index];
    if (ch === undefined) break;
    if (ch === "\\") {
      out += ch + (entry[index + 1] ?? "");
      index += 2;
      continue;
    }
    if (ch === '"') return out;
    out += ch;
    index += 1;
  }
  return undefined;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

export const buildUnfalsifiableEvidence: CustomEvidenceBuilder = (
  candidate,
  projectFiles,
): JsonValue | undefined => {
  const corpus = corpusBuilderSource(candidate, projectFiles);
  if (corpus === undefined) return undefined;
  const defaultsSource = fileSource(DEFAULTS_PATH, projectFiles);
  if (defaultsSource === undefined) return undefined;
  const entry = defaultsEntry(defaultsSource, corpus.rule);
  if (entry === undefined) return undefined;
  const question = firstStringField(entry, "question");
  if (question === undefined) return undefined;
  const focus = firstStringField(entry, "focus") ?? "";
  const hasCriteria = entry.includes("criteria");
  const questionWords = wordCount(question);
  const focusWords = wordCount(focus);
  if (!hasCriteria) {
    const evidence: UnfalsifiableProposition = {
      rule: corpus.rule,
      filePath: candidate.filePath,
      proposition: corpus.rule,
      flaw: "missing-answer-conditions",
      questionWords,
      focusWords,
      hasCriteria,
    };
    return evidence;
  }
  if (questionWords + focusWords < VACUOUS_WORD_FLOOR) {
    const evidence: UnfalsifiableProposition = {
      rule: corpus.rule,
      filePath: candidate.filePath,
      proposition: corpus.rule,
      flaw: "vacuous-question",
      questionWords,
      focusWords,
      hasCriteria,
    };
    return evidence;
  }
  return undefined;
};

const unboundedRule: CustomRuleDescriptor = {
  name: "no-unbounded-evidence",
  scope: "module",
  question: {
    instructions:
      "Does this rule's evidence builder walk every project file for each candidate without a named cap on how many files or items it collects? A named MAX_ cap, a slice of the file list, or a small count bound on collected items answers no. A repository-wide sweep whose results grow with the size of the tree answers yes.",
    criteria: {
      true: "The builder iterates the whole project and nothing bounds what it gathers",
      false: "The builder reads only its own candidate, performs a single lookup, or caps what it collects",
    },
  },
  message: "This evidence builder sweeps project files without a named collection cap.",
  buildEvidence: buildUnboundedEvidence,
};

const abstentionRule: CustomRuleDescriptor = {
  name: "no-missing-abstention",
  scope: "module",
  question: {
    instructions:
      "Can this rule's evidence builder return without evidence when the structure it needs is absent? A builder that always produces an evidence object forces a scored answer on every candidate, even where there is nothing to judge. A builder with an explicit path back to no evidence answers no.",
    criteria: {
      true: "The builder always returns an evidence object and can never step aside",
      false: "The builder has an explicit path that returns without evidence",
    },
  },
  message: "This evidence builder has no path that returns without evidence.",
  buildEvidence: buildMissingAbstentionEvidence,
};

const falsifiabilityRule: CustomRuleDescriptor = {
  name: "no-unfalsifiable-proposition",
  scope: "module",
  question: {
    instructions:
      "Does this rule's stated question give an evaluator a concrete observation to check, with stated conditions for each answer? A question that names what to look at and how each answer shows itself answers no. A question with no answer conditions, or one so short it names neither an observation nor its context, answers yes.",
    criteria: {
      true: "The question states no answer conditions or no checkable observation",
      false: "The question names an observation and conditions for each answer",
    },
  },
  message: "This rule's question states no checkable observation or answer conditions.",
  buildEvidence: buildUnfalsifiableEvidence,
};

export const rulehealthPlugin = {
  name: PLUGIN_NAME,
  rules: {
    "no-unbounded-evidence": unboundedRule,
    "no-missing-abstention": abstentionRule,
    "no-unfalsifiable-proposition": falsifiabilityRule,
  },
};

export default rulehealthPlugin;
