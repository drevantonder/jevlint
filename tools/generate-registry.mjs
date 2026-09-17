// Rule registry generator: the single source of assembly glue for review rules.
//
// Contract for a rule evidence file (src/evidence/<kebab>.ts):
//   1. The rule id is `jev/no-<basename>` (e.g. accidental-serialization.ts is
//      jev/no-accidental-serialization). A file may instead export
//      `const RULE_ID = "jev/..."`; when present it is authoritative.
//   2. The file exports exactly one `build*Evidence` function. Its parameters
//      are a subset of (candidate, projectFiles, changes), in any order, and
//      it returns JsonValue | undefined synchronously.
//   3. The rule id must exist in src/defaults.ts, which remains the
//      hand-authored source of truth for rule set, order, scope, and question
//      text. Defaults entries without an evidence file are extracted-only
//      rules and dispatch as handled:false, exactly as before.
//
// Adding a rule (phase 1):
//   1. Add src/evidence/<kebab>.ts exporting one build*Evidence function.
//   2. Append the rule entry (scope, question, message) to src/defaults.ts.
//   3. Run `pnpm generate:registry`.
//   4. Run `pnpm check` (includes the --check freshness gate, lint, tests).
//   5. Commit the rule files plus the regenerated glue.
//
// Outputs (all checked in; NEVER hand-edit between the GENERATED markers):
//   - src/evidence/index.ts: sorted imports plus a plain-object dispatch map
//     keyed by rule id. Each entry is a one-line arrow wrapper that adapts the
//     builder's own parameter order, so dispatch semantics are identical to
//     the previous if-chain. No runtime fs scans, no dynamic import().
//   - test/config.test.ts rule-key block: defaults.ts key order, verbatim.
//   - test/extracted-rules.test.ts rule list: (ruleId, scope) from defaults.ts,
//     sorted by rule id.
//
// Usage: `node tools/generate-registry.mjs [--check]`
//   --check exits 1 on drift without writing (wired into `pnpm check`).

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = join(root, "src", "evidence");
const defaultsPath = join(root, "src", "defaults.ts");
const indexPath = join(evidenceDir, "index.ts");
const configTestPath = join(root, "test", "config.test.ts");
const extractedTestPath = join(root, "test", "extracted-rules.test.ts");

// Shared evidence helpers: not rules, never part of the registry.
const NON_RULE_FILES = new Set([
  "index.ts",
  "repository.ts",
  "manifest-facts.ts",
  "function-scope.ts",
  "state-model.ts",
  "test-scope.ts",
  "module.ts",
]);

const KNOWN_PARAMS = ["candidate", "projectFiles", "changes"];

function fail(message) {
  console.error(`generate:registry: ${message}`);
  process.exit(1);
}

/** Parse src/defaults.ts into an ordered [{ ruleId, scope }]. */
function parseDefaults() {
  const text = readFileSync(defaultsPath, "utf8");
  const lines = text.split("\n");
  const rules = [];
  for (let i = 0; i < lines.length; i++) {
    const key = lines[i].match(/^    "(jev\/[^"]+)": \{$/);
    if (key) {
      const scope = (lines[i + 1] ?? "").match(/^      scope: "([^"]+)",$/);
      if (!scope) fail(`src/defaults.ts: no scope line after rule ${key[1]}`);
      rules.push({ ruleId: key[1], scope: scope[1] });
    }
  }
  if (rules.length === 0) fail("src/defaults.ts: no rule entries found");
  const seen = new Set();
  for (const rule of rules) {
    if (seen.has(rule.ruleId)) fail(`src/defaults.ts: duplicate rule ${rule.ruleId}`);
    seen.add(rule.ruleId);
  }
  return rules;
}

/** Capture the balanced (...) signature following `export [async] function name(`. */
function captureSignature(text, startIndex) {
  let depth = 0;
  let inString = null;
  for (let i = startIndex; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === inString) inString = null;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
    } else if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) return text.slice(startIndex + 1, i);
    }
  }
  return null;
}

/** Split a signature on top-level commas (ignoring <>[](){} nesting). */
function splitTopLevel(signature) {
  const parts = [];
  let depth = 0;
  let current = "";
  let inString = null;
  for (let i = 0; i < signature.length; i++) {
    const ch = signature[i];
    if (inString) {
      current += ch;
      if (ch === "\\") {
        current += signature[++i] ?? "";
      } else if (ch === inString) {
        inString = null;
      }
    } else if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      current += ch;
    } else if ("<([{".includes(ch)) {
      depth++;
      current += ch;
    } else if (">)]}".includes(ch)) {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") parts.push(current);
  return parts;
}

/** Scan one evidence file into { ruleId, module, builder, params }. */
function scanEvidenceFile(basename) {
  const text = readFileSync(join(evidenceDir, basename), "utf8");
  const module = basename.replace(/\.ts$/, "");
  const ruleIdMatch = text.match(/export\s+const\s+RULE_ID\s*=\s*"(jev\/[^"]+)"/);
  const ruleId = ruleIdMatch ? ruleIdMatch[1] : `jev/no-${module}`;
  const builders = [...text.matchAll(/export\s+(?:async\s+)?function\s+(build\w+Evidence)\(/g)];
  if (builders.length !== 1) {
    fail(`${basename}: expected exactly one exported build*Evidence function, found ${builders.length}`);
  }
  const builder = builders[0][1];
  if (text.includes(`async function ${builder}(`)) {
    fail(`${basename}: ${builder} must be synchronous (dispatch returns evidence directly)`);
  }
  const signature = captureSignature(text, builders[0].index + builders[0][0].length - 1);
  if (signature === null) fail(`${basename}: could not parse ${builder} signature`);
  const params = splitTopLevel(signature).map((part) => {
    const name = part.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1] ?? "";
    // Builders may underscore-prefix unused parameters (e.g. _changes);
    // dispatch is positional, so match on the canonical name.
    return name.replace(/^_+/, "");
  });
  if (params.length === 0 || params.some((p) => !KNOWN_PARAMS.includes(p))) {
    fail(`${basename}: ${builder} params must be a subset of (${KNOWN_PARAMS.join(", ")}), got (${params.join(", ")})`);
  }
  if (new Set(params).size !== params.length || !params.includes("candidate")) {
    fail(`${basename}: ${builder} params must include candidate exactly once, got (${params.join(", ")})`);
  }
  return { ruleId, module, builder, params };
}

/** Scan every rule evidence file, sorted by rule id. */
function scanRegistry(defaultIds) {
  const entries = [];
  for (const basename of readdirSync(evidenceDir).filter((f) => f.endsWith(".ts")).sort()) {
    if (NON_RULE_FILES.has(basename)) continue;
    const entry = scanEvidenceFile(basename);
    if (!defaultIds.has(entry.ruleId)) {
      fail(`${basename}: rule ${entry.ruleId} is not in src/defaults.ts (add it there, or fix RULE_ID/filename)`);
    }
    entries.push(entry);
  }
  const seen = new Map();
  for (const entry of entries) {
    if (seen.has(entry.ruleId)) {
      fail(`duplicate rule ${entry.ruleId} in ${seen.get(entry.ruleId)} and ${entry.module}.ts`);
    }
    seen.set(entry.ruleId, `${entry.module}.ts`);
  }
  entries.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
  return entries;
}

function renderIndex(entries) {
  const imports = entries.map((e) => `import { ${e.builder} } from "./${e.module}.js";`).join("\n");
  const contract = entries.map((e) => `  "${e.ruleId}": EvidenceBuilder;`).join("\n");
  const arms = entries
    .map((e) => {
      // Wrapper parameters stay in canonical order so contextual typing from
      // EvidenceBuilder assigns the right types; the call itself follows the
      // builder's declared parameter order (values are passed by name).
      const names = KNOWN_PARAMS.filter((p) => e.params.includes(p)).join(", ");
      const call = e.params.join(", ");
      return `  "${e.ruleId}": (${names}) =>\n    ${e.builder}(${call}),`;
    })
    .join("\n");
  return `// GENERATED by tools/generate-registry.mjs (run \`pnpm generate:registry\`).
// Do not hand-edit: entries self-register from src/evidence/<kebab>.ts files
// (one exported build*Evidence builder each) joined against src/defaults.ts.
import type { JsonValue } from "@typesafe-ai/sdk";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
${imports}

export type RuleEvidenceResult =
  | { handled: false }
  | { handled: true; evidence: JsonValue | undefined };

type EvidenceBuilder = (
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[],
) => JsonValue | undefined;

type EvidenceRegistry = {
${contract}
};

const evidenceBuilders: EvidenceRegistry = {
${arms}
};

export function buildRuleEvidence(
  ruleId: string,
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): RuleEvidenceResult {
  // SAFETY: the registry holds one entry per evidence-backed rule from the
  // generator; a miss is an extracted-only or unknown rule, which dispatches
  // as unhandled exactly like the previous if-chain fallthrough.
  const builder = evidenceBuilders[ruleId as keyof EvidenceRegistry];
  if (builder === undefined) {
    return { handled: false };
  }
  return { handled: true, evidence: builder(candidate, projectFiles, changes) };
}
`;
}

function replaceBlock(path, begin, end, body) {
  const text = readFileSync(path, "utf8");
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) {
    fail(`${path}: GENERATED marker block not found`);
  }
  return text.slice(0, start + begin.length) + body + text.slice(stop);
}

function renderConfigBlock(defaults) {
  const items = defaults.map((r) => `      "${r.ruleId}",`).join("\n");
  return `\n${items}\n      `;
}

function renderExtractedBlock(defaults) {
  const sorted = [...defaults].sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
  const items = sorted.map((r) => `  ["${r.ruleId}", "${r.scope}"],`).join("\n");
  return `\n${items}\n`;
}

const CONFIG_BEGIN = "// BEGIN GENERATED: rule-keys (src/defaults.ts order; do not edit — run pnpm generate:registry)";
const CONFIG_END = "// END GENERATED: rule-keys";
const EXTRACTED_BEGIN = "// BEGIN GENERATED: extracted-rules (ruleId, scope from src/defaults.ts; do not edit — run pnpm generate:registry)";
const EXTRACTED_END = "// END GENERATED: extracted-rules";

const defaults = parseDefaults();
const defaultIds = new Set(defaults.map((r) => r.ruleId));
const entries = scanRegistry(defaultIds);

const planned = [
  { path: indexPath, content: renderIndex(entries) },
  { path: configTestPath, content: replaceBlock(configTestPath, CONFIG_BEGIN, CONFIG_END, renderConfigBlock(defaults)) },
  { path: extractedTestPath, content: replaceBlock(extractedTestPath, EXTRACTED_BEGIN, EXTRACTED_END, renderExtractedBlock(defaults)) },
];

const checkOnly = process.argv.includes("--check");
let drifted = false;
for (const file of planned) {
  const current = readFileSync(file.path, "utf8");
  if (current !== file.content) {
    if (checkOnly) {
      console.error(`generate:registry: drift in ${file.path} (run pnpm generate:registry)`);
      drifted = true;
    } else {
      writeFileSync(file.path, file.content);
    }
  }
}

if (checkOnly) {
  if (drifted) process.exit(1);
  console.log(
    `generate:registry: fresh (${entries.length} dispatch entries, ${defaults.length} rule keys, ${defaults.length - entries.length} extracted-only rules)`,
  );
} else {
  console.log(
    `generate:registry: wrote ${entries.length} dispatch entries, ${defaults.length} rule keys (${defaults.length - entries.length} extracted-only without evidence builders)`,
  );
}
