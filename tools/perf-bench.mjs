#!/usr/bin/env node
// perf-bench: fixed-sample deterministic performance benchmark for jevlint.
//
// What it measures (wall-clock per phase + peak RSS):
//   1. candidacy    — extractCandidates over the fixed sample (Oxc parsing).
//   2. evidence     — buildRuleEvidence for every candidate/rule pair whose
//                     scope matches (the same preparation `audit --dry-run`
//                     performs, minus question batching).
//   3. scoring-stub — a deterministic stub evaluator over the prepared pairs
//                     in request batches of 24 (mirrors the evaluate plumbing
//                     in src/analyze.ts without touching Jev).
//
// What it NEVER does:
//   - No live Jev calls: this file imports only dist/candidates.js,
//     dist/defaults.js, and dist/evidence/index.js. It never imports the
//     TypeSafe SDK, typesafe-evaluator.js, or any cache/evaluator path.
//   - No network: plain `node tools/perf-bench.mjs` (NOT via varlock/pnpm
//     jevlint), no secret loading, no env key reads.
//   - No scores in output: per ADR-0001 jevlint reports probabilities without
//     pass/fail, and score/recall regressions are out of scope for this
//     harness. The stub computes a checksum (proof of execution), never a
//     judgment, and compare/gate only look at TIME and RSS.
//
// Usage:
//   node tools/perf-bench.mjs bench [--results-dir <dir>] [--tag <name>]
//       [--files a,b,c] [--repeat <n>]
//   node tools/perf-bench.mjs compare --baseline <file> --current <file>
//   node tools/perf-bench.mjs gate --baseline <file> --current <file>
//       [--max-regression-pct <n>] [--max-rss-growth-pct <n>]
//
// bench writes one JSON result file and prints a summary table. compare prints
// a delta table. gate exits 0 on PASS, 1 on FAIL (time/RSS only).

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import v8 from "node:v8";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// Fixed sample. Representative across pipeline roles; pinned by content hash
// (sample.hash) so runs are only comparable when the hash matches. Deliberate
// exclusions (see .scratch/perf-bench.md for the full rationale):
//   - src/defaults.ts: 555KB pure data table, zero candidates — parse cost
//     with no candidate/rule pairs, i.e. noise, not signal.
//   - generated glue (src/evidence/index.ts).
// The two largest hand-written modules (analyze.ts, cli.ts) are INCLUDED:
// post-memoization evidence holds ~350MB for the whole sample, comfortably
// inside a default heap. (Pre-memo they OOMed it through oxc-parser
// parse+visit retention; see docs.)
const SAMPLE_FILES = [
  "src/analyze.ts", // pipeline core, largest hand-written module
  "src/cache.ts", // Jev response cache path
  "src/candidates.ts", // Oxc candidacy path
  "src/cli.ts", // CLI/audit orchestration, large
  "src/config.ts", // small config module
  "src/evidence/module.ts", // graph-heavy evidence provider
  "src/evidence/state-model.ts", // state-heavy evidence provider
  "src/format.ts", // report formatting
  "src/git.ts", // repository file collection
];

// Mirrors MAX_QUESTIONS_PER_REQUEST in src/analyze.ts (count-based batching
// only; the char-budget split is Jev-request shaping, irrelevant to a stub).
const STUB_BATCH_SIZE = 24;

function fail(message) {
  console.error(`perf-bench: ${message}`);
  process.exit(1);
}

function sha12(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

// Deterministic 32-bit hash; stub pseudo-values derive from content only.
function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function parseArgs(argv) {
  const args = { command: "bench", resultsDir: ".scratch/perf-bench/results" };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "bench" || token === "compare" || token === "gate") {
      args.command = token;
    } else if (token === "--results-dir" || token === "--baseline" || token === "--current" || token === "--tag") {
      const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      args[key] = argv[index + 1];
      index += 1;
    } else if (token === "--files" || token === "--repeat" || token === "--max-regression-pct" || token === "--max-rss-growth-pct") {
      const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      args[key] = argv[index + 1];
      index += 1;
    } else if (token === "--help" || token === "-h") {
      args.help = true;
    } else {
      positional.push(token);
    }
  }
  if (positional.length > 0) fail(`unexpected arguments: ${positional.join(" ")}`);
  return args;
}

function printHelp() {
  console.log(`Usage:
  node tools/perf-bench.mjs bench [--results-dir <dir>] [--tag <name>] [--files a,b,c] [--repeat <n>]
  node tools/perf-bench.mjs compare --baseline <file> --current <file>
  node tools/perf-bench.mjs gate --baseline <file> --current <file> [--max-regression-pct <n>] [--max-rss-growth-pct <n>]

Defaults: --results-dir .scratch/perf-bench/results, --repeat 1,
--max-regression-pct 15, --max-rss-growth-pct 25.
See .scratch/perf-bench.md for the sample definition and gate shape.`);
}

function gitInfo() {
  let head = "unknown";
  let dirty = [];
  try {
    head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const status = execFileSync("git", ["status", "--short", "src/"], { cwd: root, encoding: "utf8" }).trim();
    dirty = status === "" ? [] : status.split("\n");
  } catch {
    // Git metadata is informational only; a bench must work from any tree.
  }
  return { head, dirty };
}

function distFreshness() {
  // Siblings prototype in src/ and rebuild; benching a stale dist would
  // attribute old code's performance to new code. Warn, don't fail: the
  // staleness flag is recorded in the JSON for the reader to judge.
  let srcNewest = 0;
  let distNewest = 0;
  let distMissing = false;
  const newestMtime = (dir, ext) => {
    let newest = 0;
    const visit = (current) => {
      let entries = [];
      try {
        entries = readdirSync(current);
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(current, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) visit(full);
        else if (full.endsWith(ext)) newest = Math.max(newest, stat.mtimeMs);
      }
    };
    visit(dir);
    return newest;
  };
  try {
    srcNewest = newestMtime(join(root, "src"), ".ts");
    distNewest = newestMtime(join(root, "dist"), ".js");
  } catch {
    distMissing = true;
  }
  if (distNewest === 0) distMissing = true;
  return { srcNewestMtime: srcNewest, distNewestMtime: distNewest, stale: distMissing || distNewest < srcNewest };
}

function loadSample(files) {
  const sorted = [...files].sort();
  const projectFiles = sorted.map((filePath) => ({
    filePath,
    source: readFileSync(join(root, filePath), "utf8"),
  }));
  const entries = projectFiles.map((file) => ({
    path: file.filePath,
    bytes: Buffer.byteLength(file.source, "utf8"),
    sha12: sha12(file.source),
  }));
  const hash = sha12(entries.map((entry) => `${entry.path}:${entry.sha12}`).join("\n"));
  return { projectFiles, sample: { files: entries, hash } };
}

function startRssSampler() {
  const first = process.memoryUsage();
  const sampler = { rssPeak: first.rss, heapPeak: first.heapUsed };
  const timer = setInterval(() => {
    const memory = process.memoryUsage();
    if (memory.rss > sampler.rssPeak) sampler.rssPeak = memory.rss;
    if (memory.heapUsed > sampler.heapPeak) sampler.heapPeak = memory.heapUsed;
  }, 20);
  timer.unref?.();
  return { sampler, stop: () => clearInterval(timer) };
}

const toMB = (bytes) => Math.round((bytes / 1048576) * 10) / 10;

function runOnce(modules, projectFiles) {
  const { extractCandidates } = modules.candidates;
  const { buildRuleEvidence } = modules.evidence;
  const rules = Object.entries(modules.defaults.defaultConfig.rules);

  // Phase 1: candidacy.
  const candidacyStart = performance.now();
  const candidatesByFile = new Map();
  let candidateCount = 0;
  const byKind = {};
  for (const file of projectFiles) {
    const candidates = extractCandidates(file.filePath, file.source);
    candidatesByFile.set(file.filePath, candidates);
    candidateCount += candidates.length;
    for (const candidate of candidates) {
      byKind[candidate.kind] = (byKind[candidate.kind] ?? 0) + 1;
    }
  }
  const candidacyMs = performance.now() - candidacyStart;

  // Phase 2: evidence (the `audit --dry-run` preparation path, timed per rule
  // so pairwise-rule-bound prototypes can attribute their wins).
  const evidenceStart = performance.now();
  const perRule = new Map();
  const prepared = [];
  let pairCount = 0;
  let preparedCount = 0;
  let abstentionCount = 0;
  let unhandledCount = 0;
  for (const file of projectFiles) {
    const candidates = candidatesByFile.get(file.filePath) ?? [];
    for (const candidate of candidates) {
      for (const [ruleId, rule] of rules) {
        if (rule.scope !== candidate.kind) continue;
        pairCount += 1;
        const start = performance.now();
        const result = buildRuleEvidence(ruleId, candidate, projectFiles, []);
        const elapsed = performance.now() - start;
        const entry = perRule.get(ruleId) ?? { ruleId, calls: 0, ms: 0 };
        entry.calls += 1;
        entry.ms += elapsed;
        perRule.set(ruleId, entry);
        if (!result.handled) {
          unhandledCount += 1;
        } else if (result.evidence === undefined) {
          abstentionCount += 1;
        } else {
          preparedCount += 1;
          prepared.push({ candidateId: candidate.id, ruleId, evidenceSize: JSON.stringify(result.evidence).length });
        }
      }
    }
  }
  const evidenceMs = performance.now() - evidenceStart;

  // Phase 3: scoring-stub. Deterministic pseudo-values from content hashes in
  // fixed batches; the accumulated checksum proves execution. These numbers
  // are plumbing overhead, NOT judgments — they never enter compare/gate.
  const stubStart = performance.now();
  let checksum = 0;
  let batchCount = 0;
  for (let index = 0; index < prepared.length; index += STUB_BATCH_SIZE) {
    const batch = prepared.slice(index, index + STUB_BATCH_SIZE);
    batchCount += 1;
    for (const question of batch) {
      const pseudo = (fnv1a(`${question.ruleId}${question.candidateId}${question.evidenceSize}`) % 1000) / 1000;
      checksum = (checksum + Math.floor(pseudo * 1000)) % 1000003;
    }
  }
  const scoringStubMs = performance.now() - stubStart;

  const evidenceByRule = [...perRule.values()]
    .map((entry) => ({ ...entry, ms: Math.round(entry.ms * 10) / 10 }))
    .sort((left, right) => right.ms - left.ms);

  return {
    counts: {
      files: projectFiles.length,
      candidates: candidateCount,
      candidatesByKind: byKind,
      pairs: pairCount,
      prepared: preparedCount,
      abstentions: abstentionCount,
      unhandled: unhandledCount,
      stubBatches: batchCount,
    },
    phases: {
      candidacyMs: Math.round(candidacyMs * 10) / 10,
      evidenceMs: Math.round(evidenceMs * 10) / 10,
      scoringStubMs: Math.round(scoringStubMs * 10) / 10,
    },
    evidenceByRule,
    stubChecksum: checksum,
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

async function runBench(args) {
  const files = args.files === undefined ? SAMPLE_FILES : args.files.split(",").map((part) => part.trim()).filter(Boolean);
  if (files.length === 0) fail("--files must list at least one file");
  const repeat = args.repeat === undefined ? 1 : Number.parseInt(args.repeat, 10);
  if (!Number.isInteger(repeat) || repeat < 1) fail("--repeat must be a positive integer");

  const loadStart = performance.now();
  let modules;
  try {
    const [candidates, defaults, evidence] = await Promise.all([
      import("../dist/candidates.js"),
      import("../dist/defaults.js"),
      import("../dist/evidence/index.js"),
    ]);
    modules = { candidates, defaults, evidence };
  } catch (error) {
    fail(`cannot load dist/ (${error instanceof Error ? error.message : String(error)}). Run \`pnpm build\` first.`);
  }
  let loaded;
  try {
    loaded = loadSample(files);
  } catch (error) {
    fail(`cannot load sample (${error instanceof Error ? error.message : String(error)})`);
  }
  const loadMs = performance.now() - loadStart;
  const freshness = distFreshness();
  if (freshness.stale) {
    console.error("perf-bench: WARNING: dist/ is older than src/ (or missing). Run `pnpm build` first; results flagged stale.");
  }

  const wallStart = performance.now();
  const runs = [];
  for (let run = 1; run <= repeat; run += 1) {
    const { sampler, stop } = startRssSampler();
    const result = runOnce(modules, loaded.projectFiles);
    // Sample once more synchronously so the peak includes post-run retention.
    const final = process.memoryUsage();
    sampler.rssPeak = Math.max(sampler.rssPeak, final.rss);
    sampler.heapPeak = Math.max(sampler.heapPeak, final.heapUsed);
    stop();
    runs.push({ ...result, rssPeakBytes: sampler.rssPeak, heapPeakBytes: sampler.heapPeak });
    if (repeat > 1) {
      const total = result.phases.candidacyMs + result.phases.evidenceMs + result.phases.scoringStubMs;
      console.error(`perf-bench: run ${run}/${repeat}: total ${total.toFixed(1)} ms, peak RSS ${toMB(sampler.rssPeak)} MB`);
    }
  }
  const wallMs = performance.now() - wallStart;

  const totals = runs.map((run) => run.phases.candidacyMs + run.phases.evidenceMs + run.phases.scoringStubMs);
  const medianIndex = runs.length === 1 ? 0 : totals.indexOf(median(totals));
  const representative = runs[medianIndex];
  const result = {
    tool: "perf-bench",
    version: 1,
    tag: args.tag ?? null,
    createdAt: new Date().toISOString(),
    nodeVersion: process.version,
    heapLimitMB: toMB(v8.getHeapStatistics().heap_size_limit),
    parseCache: process.env.JEVLINT_PARSE_CACHE === "0" ? "bypass" : "on",
    platform: `${process.platform}-${process.arch}`,
    git: gitInfo(),
    dist: freshness,
    sample: { ...loaded.sample, override: args.files !== undefined },
    counts: representative.counts,
    phases: {
      loadMs: Math.round(loadMs * 10) / 10,
      candidacyMs: Math.round(median(runs.map((run) => run.phases.candidacyMs)) * 10) / 10,
      evidenceMs: Math.round(median(runs.map((run) => run.phases.evidenceMs)) * 10) / 10,
      scoringStubMs: Math.round(median(runs.map((run) => run.phases.scoringStubMs)) * 10) / 10,
      totalMs: 0,
      wallMs: Math.round(wallMs * 10) / 10,
    },
    evidenceByRule: representative.evidenceByRule,
    rss: {
      peakMB: toMB(median(runs.map((run) => run.rssPeakBytes))),
      heapPeakMB: toMB(median(runs.map((run) => run.heapPeakBytes))),
      finalMB: toMB(process.memoryUsage().rss),
    },
    stubChecksum: representative.stubChecksum,
    repeat,
    runs: repeat === 1 ? undefined : runs.map((run) => ({
      phases: run.phases,
      totalMs: Math.round((run.phases.candidacyMs + run.phases.evidenceMs + run.phases.scoringStubMs) * 10) / 10,
      rssPeakMB: toMB(run.rssPeakBytes),
      heapPeakMB: toMB(run.heapPeakBytes),
    })),
  };
  result.phases.totalMs = Math.round(
    (result.phases.candidacyMs + result.phases.evidenceMs + result.phases.scoringStubMs) * 10,
  ) / 10;

  const resultsDir = resolve(root, args.resultsDir);
  mkdirSync(resultsDir, { recursive: true });
  const stamp = result.createdAt.replaceAll(":", "").replaceAll("-", "").split(".")[0].replace("T", "-");
  const outPath = join(resultsDir, `${stamp}${result.tag === null ? "" : `-${result.tag.replaceAll(/[^a-zA-Z0-9_-]/g, "_")}`}.json`);
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);

  printSummary(result);
  console.log(`\nwrote ${outPath}`);
}

function printSummary(result) {
  const rows = [
    ["phase", "ms"],
    ["load", result.phases.loadMs.toFixed(1)],
    ["candidacy", result.phases.candidacyMs.toFixed(1)],
    ["evidence", result.phases.evidenceMs.toFixed(1)],
    ["scoring-stub", result.phases.scoringStubMs.toFixed(1)],
    ["total (median)", result.phases.totalMs.toFixed(1)],
  ];
  printTable(rows);
  console.log(
    `counts: files=${result.counts.files} candidates=${result.counts.candidates} `
    + `pairs=${result.counts.pairs} prepared=${result.counts.prepared} `
    + `abstentions=${result.counts.abstentions} unhandled=${result.counts.unhandled} `
    + `stubBatches=${result.counts.stubBatches}`,
  );
  console.log(`rss: peak=${result.rss.peakMB} MB final=${result.rss.finalMB} MB`);
  console.log(`sample: hash=${result.sample.hash}${result.sample.override ? " (OVERRIDDEN --files, not comparable)" : ""}`);
  if (result.dist.stale) console.log("dist: STALE (rebuild with `pnpm build` before comparing)");
  console.log("slowest evidence rules:");
  printTable([["rule", "calls", "ms"], ...result.evidenceByRule.slice(0, 10).map((entry) => [entry.ruleId, String(entry.calls), entry.ms.toFixed(1)])]);
}

function printTable(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column]).length)));
  for (const row of rows) {
    console.log(row.map((cell, column) => String(cell).padEnd(widths[column])).join("  "));
  }
}

function loadResult(path) {
  try {
    return JSON.parse(readFileSync(resolve(root, path), "utf8"));
  } catch (error) {
    fail(`cannot read ${path} (${error instanceof Error ? error.message : String(error)})`);
  }
}

function deltaPct(current, baseline) {
  if (baseline === 0) return current === 0 ? "n/a" : "+inf";
  const pct = ((current - baseline) / baseline) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function runCompare(args) {
  if (args.baseline === undefined || args.current === undefined) fail("compare requires --baseline <file> --current <file>");
  const baseline = loadResult(args.baseline);
  const current = loadResult(args.current);
  if (baseline.tool !== "perf-bench" || current.tool !== "perf-bench") fail("both files must be perf-bench results (tool: perf-bench)");
  if (baseline.sample.hash !== current.sample.hash) {
    console.log(`INCOMPARABLE SAMPLES: baseline=${baseline.sample.hash} current=${current.sample.hash}`);
    console.log("(re-run both on the same sample; --files overrides are never comparable)\n");
  } else if (baseline.parseCache !== current.parseCache) {
    console.log(`CACHE-MODE MISMATCH: baseline=${baseline.parseCache ?? "unknown"} current=${current.parseCache ?? "unknown"}`);
    console.log("(JEVLINT_PARSE_CACHE=0 bypasses the evidence parse cache: counts stay comparable, times do not)\n");
  } else {
    console.log(`sample ${current.sample.hash} (${current.counts.files} files)\n`);
  }
  const rows = [["phase", "baseline ms", "current ms", "delta"]];
  for (const key of ["loadMs", "candidacyMs", "evidenceMs", "scoringStubMs", "totalMs"]) {
    rows.push([key.replace("Ms", ""), baseline.phases[key].toFixed(1), current.phases[key].toFixed(1), deltaPct(current.phases[key], baseline.phases[key])]);
  }
  printTable(rows);
  console.log("");
  printTable([
    ["metric", "baseline", "current", "delta"],
    ["peak RSS MB", String(baseline.rss.peakMB), String(current.rss.peakMB), deltaPct(current.rss.peakMB, baseline.rss.peakMB)],
    ["peak heap MB", String(baseline.rss.heapPeakMB ?? "n/a"), String(current.rss.heapPeakMB ?? "n/a"),
      baseline.rss.heapPeakMB === undefined || current.rss.heapPeakMB === undefined
        ? "n/a"
        : deltaPct(current.rss.heapPeakMB, baseline.rss.heapPeakMB)],
    ["candidates", String(baseline.counts.candidates), String(current.counts.candidates), deltaPct(current.counts.candidates, baseline.counts.candidates)],
    ["pairs", String(baseline.counts.pairs), String(current.counts.pairs), deltaPct(current.counts.pairs, baseline.counts.pairs)],
    ["prepared", String(baseline.counts.prepared), String(current.counts.prepared), deltaPct(current.counts.prepared, baseline.counts.prepared)],
  ]);
  console.log("\n(count deltas are informational only — score/recall regressions are out of scope.)");
  if (current.dist.stale) console.log("WARNING: current dist was STALE at bench time; rebuild and re-run before trusting deltas.");
  if (baseline.dist.stale) console.log("WARNING: baseline dist was STALE at bench time; rebuild and re-run before trusting deltas.");
}

function runGate(args) {
  // Suggested regression-gate shape: thresholds on TIME and RSS only, never on
  // scores (score/recall regressions are out of scope per the mission and
  // ADR-0001). NOT wired into `pnpm check`; the coordinator decides gating.
  if (args.baseline === undefined || args.current === undefined) fail("gate requires --baseline <file> --current <file>");
  const maxRegressionPct = args.maxRegressionPct === undefined ? 15 : Number(args.maxRegressionPct);
  const maxRssGrowthPct = args.maxRssGrowthPct === undefined ? 25 : Number(args.maxRssGrowthPct);
  if (!(maxRegressionPct > 0) || !(maxRssGrowthPct > 0)) fail("--max-regression-pct and --max-rss-growth-pct must be positive numbers");
  const baseline = loadResult(args.baseline);
  const current = loadResult(args.current);
  const failures = [];
  const notes = [];
  if (baseline.sample.hash !== current.sample.hash) {
    failures.push(`sample hash differs (baseline=${baseline.sample.hash} current=${current.sample.hash})`);
  }
  if (current.sample.override === true) notes.push("current used --files override (not a canonical sample run)");
  if (current.dist.stale === true) notes.push("current dist was STALE at bench time");
  // Floor: sub-50ms phases are timer noise, not signal. They are reported by
  // compare but never fail the gate.
  const FLOOR_MS = 50;
  for (const key of ["candidacyMs", "evidenceMs", "scoringStubMs", "totalMs"]) {
    const base = baseline.phases[key];
    const now = current.phases[key];
    const label = key.replace("Ms", "");
    if (base < FLOOR_MS) {
      console.log(`gate skip: ${label} baseline ${base.toFixed(1)} ms below ${FLOOR_MS} ms floor (noise, not signal)`);
      continue;
    }
    const regression = ((now - base) / base) * 100;
    if (regression > maxRegressionPct) {
      failures.push(`${label} regressed ${regression.toFixed(1)}% (limit ${maxRegressionPct}%)`);
    } else {
      console.log(`gate ok: ${label} ${regression >= 0 ? "+" : ""}${regression.toFixed(1)}% (limit +${maxRegressionPct}%)`);
    }
  }
  const rssGrowth = baseline.rss.peakMB === 0
    ? 0
    : ((current.rss.peakMB - baseline.rss.peakMB) / baseline.rss.peakMB) * 100;
  if (rssGrowth > maxRssGrowthPct) {
    failures.push(`peak RSS grew ${rssGrowth.toFixed(1)}% (limit ${maxRssGrowthPct}%)`);
  } else {
    console.log(`gate ok: peak RSS ${rssGrowth >= 0 ? "+" : ""}${rssGrowth.toFixed(1)}% (limit +${maxRssGrowthPct}%)`);
  }
  if (baseline.rss.heapPeakMB !== undefined && current.rss.heapPeakMB !== undefined) {
    const heapGrowth = baseline.rss.heapPeakMB === 0
      ? 0
      : ((current.rss.heapPeakMB - baseline.rss.heapPeakMB) / baseline.rss.heapPeakMB) * 100;
    if (heapGrowth > maxRssGrowthPct) {
      failures.push(`peak heap grew ${heapGrowth.toFixed(1)}% (limit ${maxRssGrowthPct}%)`);
    } else {
      console.log(`gate ok: peak heap ${heapGrowth >= 0 ? "+" : ""}${heapGrowth.toFixed(1)}% (limit +${maxRssGrowthPct}%)`);
    }
  }
  for (const note of notes) console.log(`gate note: ${note}`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`gate FAIL: ${failure}`);
    process.exit(1);
  }
  console.log("gate PASS");
}

// Heap guard. With the evidence parse cache on (the default), the canonical
// sample peaks near ~350MB — a default heap is plenty. With the cache
// bypassed (JEVLINT_PARSE_CACHE=0, the documented A/B switch), per-pair
// retention returns and the sample needs ~6GB+; re-exec under a larger heap
// so the A/B run works instead of OOMing. The heap limit is recorded in the
// JSON (heapLimitMB) for the reader to judge.
function ensureHeap(argv) {
  if (process.env.PERF_BENCH_NO_REEXEC === "1") return;
  const bypassed = process.env.JEVLINT_PARSE_CACHE === "0";
  const minHeapBytes = (bypassed ? 6 : 2) * 1024 * 1024 * 1024;
  if (v8.getHeapStatistics().heap_size_limit >= minHeapBytes) return;
  const flag = bypassed ? "--max-old-space-size=8192" : "--max-old-space-size=4096";
  console.error(`perf-bench: re-executing with ${flag} (default heap cannot hold the sample)`);
  const child = spawnSync(process.execPath, [flag, ...argv], {
    stdio: "inherit",
    env: { ...process.env, PERF_BENCH_NO_REEXEC: "1" },
  });
  process.exit(child.status ?? 1);
}

const args = parseArgs(process.argv.slice(2));
if (args.command === "bench" && args.help !== true) {
  ensureHeap(process.argv.slice(1));
}
if (args.help === true) {
  printHelp();
} else if (args.command === "bench") {
  await runBench(args);
} else if (args.command === "compare") {
  runCompare(args);
} else if (args.command === "gate") {
  runGate(args);
}
