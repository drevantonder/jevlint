import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeAuditWithFailures, analyzeFileWithFailures } from "../src/analyze.js";
import { loadConfig } from "../src/config.js";
import type {
  EvaluationRequest,
  Evaluator,
  JevLintConfig,
  RuleConfig,
} from "../src/types.js";

class FixedEvaluator implements Evaluator {
  requests: EvaluationRequest[] = [];

  constructor(private readonly score = 0.8) {}

  async evaluate(request: EvaluationRequest): Promise<Record<string, number>> {
    this.requests.push(request);
    return Object.fromEntries(Object.keys(request.questions).map((id) => [id, this.score]));
  }
}

const FIXTURE_URL = new URL("./fixtures/custom-rules/todo-plugin.ts", import.meta.url);

async function projectWith(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "jevlint-custom-"));
  for (const [name, content] of Object.entries(files)) {
    const path = join(directory, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return directory;
}

async function pluginProject(extraConfig: string): Promise<string> {
  const plugin = await readFile(FIXTURE_URL, "utf8");
  return projectWith({
    "rules/todo-plugin.ts": plugin,
    "jevlint.config.ts": extraConfig,
  });
}

const BASE_CONFIG = `export default {
  plugins: [{ name: "acme", specifier: "./rules/todo-plugin.ts" }],
};\n`;

const SOURCE = `// TODO: fix this later\nexport function forward(value: string) { return value; }\n`;

function customOnly(config: JevLintConfig): JevLintConfig {
  const rules = Object.fromEntries(
    Object.entries(config.rules).filter(([key]) => !key.startsWith("jev/")),
  );
  const customEvidence = Object.fromEntries(
    Object.entries(config.customEvidence ?? {}).filter(([key]) => !key.startsWith("jev/")),
  );
  return { rules, customEvidence };
}

describe("custom rules", () => {
  it("registers plugin rules enabled by default under the entry prefix", async () => {
    const directory = await pluginProject(BASE_CONFIG);

    const config = await loadConfig({ cwd: directory });

    expect(config.rules["acme/no-todo-without-ticket"]).toEqual({
      scope: "comment",
      category: "style",
      question: {
        instructions: "Does this TODO comment name a trackable ticket?",
        criteria: {
          true: "The comment references a ticket identifier",
          false: "The comment names no ticket",
        },
      },
      message: "TODO comment names no trackable ticket.",
    });
    expect(config.rules["acme/no-forwarding-function"]?.scope).toBe("function");
    expect(config.customEvidence?.["acme/no-todo-without-ticket"] instanceof Function).toBe(true);
  });

  it("disables a custom rule with off", async () => {
    const directory = await pluginProject(`export default {
      plugins: [{ name: "acme", specifier: "./rules/todo-plugin.ts" }],
      rules: { "acme/no-todo-without-ticket": "off" },
    };\n`);

    const config = await loadConfig({ cwd: directory });

    expect(config.rules["acme/no-todo-without-ticket"]).toBeUndefined();
    expect(config.customEvidence?.["acme/no-todo-without-ticket"] instanceof Function).toBe(false);
    expect(config.rules["acme/no-forwarding-function"]).toBeDefined();
  });

  it("reshapes a custom rule through a RuleConfig override while keeping its builder", async () => {
    const directory = await pluginProject(`export default {
      plugins: [{ name: "acme", specifier: "./rules/todo-plugin.ts" }],
      rules: {
        "acme/no-forwarding-function": {
          scope: "comment",
          question: { instructions: "Reshaped question?" },
          message: "Reshaped message.",
        },
      },
    };\n`);

    const config = await loadConfig({ cwd: directory });

    expect(config.rules["acme/no-forwarding-function"]).toEqual({
      scope: "comment",
      category: "maintainability",
      question: { instructions: "Reshaped question?" },
      message: "Reshaped message.",
    });
    expect(config.customEvidence?.["acme/no-forwarding-function"] instanceof Function).toBe(true);

    const evaluator = new FixedEvaluator();
    const result = await analyzeFileWithFailures(
      {
        filePath: "src/a.ts",
        source: SOURCE,
        changedLines: [{ start: 1, end: 2 }],
        config: customOnly(config),
      },
      evaluator,
    );
    expect(result.judgments.map((judgment) => judgment.ruleId).sort()).toEqual([
      "acme/no-forwarding-function",
      "acme/no-todo-without-ticket",
    ]);
  });

  it("scores custom judgments like bundled ones, with evidence and abstentions", async () => {
    const directory = await pluginProject(BASE_CONFIG);
    const config = customOnly(await loadConfig({ cwd: directory }));
    const evaluator = new FixedEvaluator(0.8);

    const result = await analyzeFileWithFailures(
      {
        filePath: "src/a.ts",
        source: SOURCE,
        changedLines: [{ start: 1, end: 2 }],
        config,
      },
      evaluator,
    );

    expect(result.failures).toEqual([]);
    // Tied probabilities order by category rank: maintainability before style.
    expect(result.judgments).toEqual([
      expect.objectContaining({
        ruleId: "acme/no-forwarding-function",
        message: "Function only forwards its arguments.",
        probability: 0.8,
        category: "maintainability",
        filePath: "src/a.ts",
        candidateKind: "function",
        span: expect.objectContaining({
          start: expect.objectContaining({ line: 2 }),
        }),
        evidence: expect.objectContaining({ source: expect.any(String) }),
      }),
      expect.objectContaining({
        ruleId: "acme/no-todo-without-ticket",
        message: "TODO comment names no trackable ticket.",
        probability: 0.8,
        category: "style",
        candidateKind: "comment",
        evidence: expect.objectContaining({ hasTicket: false }),
      }),
    ]);
    const questionTexts = evaluator.requests.flatMap((request) =>
      Object.values(request.questions).map((question) => JSON.stringify(question)),
    );
    expect(questionTexts.some((text) => text.includes("acme/no-todo-without-ticket"))).toBe(true);
    expect(questionTexts.some((text) => text.includes("acme/no-forwarding-function"))).toBe(true);
  });

  it("counts undefined evidence as a structural abstention, never a probability", async () => {
    const directory = await pluginProject(BASE_CONFIG);
    const config = customOnly(await loadConfig({ cwd: directory }));

    const result = await analyzeFileWithFailures(
      {
        filePath: "src/a.ts",
        source: `// just a note\nexport function forward(value: string) { return value; }\n`,
        changedLines: [{ start: 1, end: 2 }],
        config,
      },
      new FixedEvaluator(),
    );

    expect(result.judgments.map((judgment) => judgment.ruleId)).toEqual([
      "acme/no-forwarding-function",
    ]);
    expect(result.abstentions).toContainEqual({
      ruleId: "acme/no-todo-without-ticket",
      candidateKind: "comment",
      count: 1,
    });
  });

  it("reports a throwing builder as an evaluation failure without a probability", async () => {
    const config: JevLintConfig = {
      rules: {
        "acme/ok-rule": {
          scope: "function",
          category: "maintainability",
          question: { instructions: "Is this fine?" },
          message: "Fine.",
        } satisfies RuleConfig,
        "acme/boom-rule": {
          scope: "function",
          category: "maintainability",
          question: { instructions: "Does this explode?" },
          message: "Exploded.",
        } satisfies RuleConfig,
      },
      customEvidence: {
        "acme/ok-rule": () => ({ seen: true }),
        "acme/boom-rule": () => {
          throw new Error("kaboom");
        },
      },
    };

    const result = await analyzeFileWithFailures(
      {
        filePath: "src/a.ts",
        source: `export function forward(value: string) { return value; }\n`,
        changedLines: [{ start: 1, end: 1 }],
        config,
      },
      new FixedEvaluator(),
    );

    expect(result.judgments.map((judgment) => judgment.ruleId)).toEqual(["acme/ok-rule"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({
      filePath: "src/a.ts",
      candidateIds: expect.any(Array),
      ruleIds: ["acme/boom-rule"],
      questionCount: 1,
    });
  });

  it("reports promise and non-JSON builders as evaluation failures", async () => {
    const directory = await projectWith({
      "rules/late.ts": `export default { rules: { "late-rule": {
        name: "late-rule", scope: "function", category: "maintainability",
        question: { instructions: "Late?" }, message: "Late.",
        buildEvidence: () => Promise.resolve({ late: true }),
      } } };\n`,
      "rules/strange.ts": `export default { rules: { "strange-rule": {
        name: "strange-rule", scope: "function", category: "maintainability",
        question: { instructions: "Strange?" }, message: "Strange.",
        buildEvidence: () => (() => 1),
      } } };\n`,
      "jevlint.config.ts": `export default {
        plugins: [
          { name: "acme", specifier: "./rules/late.ts" },
          { name: "other", specifier: "./rules/strange.ts" },
        ],
      };\n`,
    });
    const config = customOnly(await loadConfig({ cwd: directory }));

    const result = await analyzeFileWithFailures(
      {
        filePath: "src/a.ts",
        source: `export function forward(value: string) { return value; }\n`,
        changedLines: [{ start: 1, end: 1 }],
        config,
      },
      new FixedEvaluator(),
    );

    expect(result.judgments).toEqual([]);
    expect(result.failures).toHaveLength(2);
    expect(result.failures.map((failure) => failure.ruleIds).sort()).toEqual([
      ["acme/late-rule"],
      ["other/strange-rule"],
    ]);
  });

  it("keeps custom rules in audit coverage and omits change-scope customs from scoring", async () => {
    const directory = await pluginProject(`export default {
      plugins: [{ name: "acme", specifier: "./rules/todo-plugin.ts" }],
    };\n`);
    const loaded = await loadConfig({ cwd: directory });
    const config: JevLintConfig = {
      rules: { ...customOnly(loaded).rules },
      customEvidence: { ...customOnly(loaded).customEvidence },
    };
    config.rules["acme/change-rule"] = {
      scope: "change",
      category: "maintainability",
      question: { instructions: "Whole change?" },
      message: "Change.",
    };
    config.customEvidence!["acme/change-rule"] = () => ({ seen: true });

    const result = await analyzeAuditWithFailures(
      {
        projectFiles: [{ filePath: "src/a.ts", source: SOURCE }],
        config,
        dryRun: true,
      },
      new FixedEvaluator(),
    );

    expect(result.coverage.questionsPrepared).toBeGreaterThan(0);
    expect(result.coverage.unscoredRules).toContainEqual({
      ruleId: "acme/change-rule",
      scope: "change",
      reason: "requires-before-after-change-context",
    });
    expect(result.coverage.omittedByRule.some((entry) => entry.ruleId.startsWith("acme/"))).toBe(false);
  });

  it("rejects unknown rules keys with a single suggestion", async () => {
    const directory = await pluginProject(`export default {
      plugins: [{ name: "acme", specifier: "./rules/todo-plugin.ts" }],
      rules: { "jev/no-pass-through-wrappe": "off" },
    };\n`);

    await expect(loadConfig({ cwd: directory })).rejects.toThrow(
      'jevlint: unknown rule "jev/no-pass-through-wrappe". Did you mean "jev/no-pass-through-wrapper"?',
    );
  });

  it("rejects a missing plugin path", async () => {
    const directory = await pluginProject(`export default {
      plugins: [{ name: "acme", specifier: "./rules/missing.ts" }],
    };\n`);

    await expect(loadConfig({ cwd: directory })).rejects.toThrow(
      'jevlint: plugin "acme" not found at rules/missing.ts (relative to jevlint.config.ts).',
    );
  });

  it("rejects bare, absolute, and escaping specifiers", async () => {
    const bare = await pluginProject(`export default {
      plugins: [{ name: "acme", specifier: "eslint-plugin-foo" }],
    };\n`);
    await expect(loadConfig({ cwd: bare })).rejects.toThrow(
      'jevlint: plugin "acme" specifier must be a project-local relative path, got "eslint-plugin-foo".',
    );

    const absolute = await pluginProject(`export default {
      plugins: [{ name: "acme", specifier: "/tmp/plugin.ts" }],
    };\n`);
    await expect(loadConfig({ cwd: absolute })).rejects.toThrow(
      'jevlint: plugin "acme" specifier must be a project-local relative path, got "/tmp/plugin.ts".',
    );

    const escaping = await pluginProject(`export default {
      plugins: [{ name: "acme", specifier: "../outside.ts" }],
    };\n`);
    await expect(loadConfig({ cwd: escaping })).rejects.toThrow(
      'jevlint: plugin "acme" specifier must be a project-local relative path, got "../outside.ts".',
    );
  });

  it("rejects reserved and invalid plugin names", async () => {
    const reserved = await pluginProject(`export default {
      plugins: [{ name: "jev", specifier: "./rules/todo-plugin.ts" }],
    };\n`);
    await expect(loadConfig({ cwd: reserved })).rejects.toThrow(
      'jevlint: plugin name "jev" is reserved or invalid (lowercase letters, digits, hyphens; not "jev").',
    );

    const invalid = await pluginProject(`export default {
      plugins: [{ name: "Acme!", specifier: "./rules/todo-plugin.ts" }],
    };\n`);
    await expect(loadConfig({ cwd: invalid })).rejects.toThrow(
      'jevlint: plugin name "Acme!" is reserved or invalid (lowercase letters, digits, hyphens; not "jev").',
    );
  });

  it("rejects descriptors with invalid shape, scope, or builder", async () => {
    const badDescriptor = await projectWith({
      "rules/bad.ts": `export default { name: "acme", rules: { "bad-rule": {
        name: "bad-rule", scope: "comment", category: "style",
        question: { instructions: "Bad?" },
        buildEvidence: () => ({}),
      } } };\n`,
      "jevlint.config.ts": `export default {
        plugins: [{ name: "acme", specifier: "./rules/bad.ts" }],
      };\n`,
    });
    await expect(loadConfig({ cwd: badDescriptor })).rejects.toThrow(
      /jevlint: plugin "acme" rule "bad-rule": .* \(in rules\/bad\.ts\)\./,
    );

    const badScope = await projectWith({
      "rules/bad.ts": `export default { name: "acme", rules: { "bad-rule": {
        name: "bad-rule", scope: "file",
        question: { instructions: "Bad?" }, message: "Bad.",
        buildEvidence: () => ({}),
      } } };\n`,
      "jevlint.config.ts": `export default {
        plugins: [{ name: "acme", specifier: "./rules/bad.ts" }],
      };\n`,
    });
    await expect(loadConfig({ cwd: badScope })).rejects.toThrow(
      'jevlint: plugin "acme" rule "bad-rule": scope must be one of comment, function, abstraction, change, module.',
    );

    const asyncBuilder = await projectWith({
      "rules/bad.ts": `export default { name: "acme", rules: { "bad-rule": {
        name: "bad-rule", scope: "comment", category: "style",
        question: { instructions: "Bad?" }, message: "Bad.",
        buildEvidence: async () => ({}),
      } } };\n`,
      "jevlint.config.ts": `export default {
        plugins: [{ name: "acme", specifier: "./rules/bad.ts" }],
      };\n`,
    });
    await expect(loadConfig({ cwd: asyncBuilder })).rejects.toThrow(
      'jevlint: plugin "acme" rule "bad-rule": evidence builder must be a synchronous function.',
    );
  });

  it("requires an explicit rule name and rejects module name mismatches", async () => {
    const nameless = await projectWith({
      "rules/bad.ts": `export default {
        scope: "comment", category: "style",
        question: { instructions: "Nameless?" }, message: "Nameless.",
        buildEvidence: () => ({}),
      };\n`,
      "jevlint.config.ts": `export default {
        plugins: [{ name: "acme", specifier: "./rules/bad.ts" }],
      };\n`,
    });
    await expect(loadConfig({ cwd: nameless })).rejects.toThrow(
      /jevlint: plugin "acme" rule "\?":/,
    );

    const plugin = await readFile(FIXTURE_URL, "utf8");
    const mismatched = await projectWith({
      "rules/todo-plugin.ts": plugin,
      "jevlint.config.ts": `export default {
        plugins: [{ name: "other", specifier: "./rules/todo-plugin.ts" }],
      };\n`,
    });
    await expect(loadConfig({ cwd: mismatched })).rejects.toThrow(
      'jevlint: plugin at rules/todo-plugin.ts declares name "acme" but is registered as "other".',
    );
  });

  it("rejects duplicate plugin names and duplicate rule keys", async () => {
    const plugin = await readFile(FIXTURE_URL, "utf8");
    const duplicateName = await projectWith({
      "rules/a.ts": plugin,
      "rules/b.ts": plugin,
      "jevlint.config.ts": `export default {
        plugins: [
          { name: "acme", specifier: "./rules/a.ts" },
          { name: "acme", specifier: "./rules/b.ts" },
        ],
      };\n`,
    });
    await expect(loadConfig({ cwd: duplicateName })).rejects.toThrow(
      'jevlint: duplicate custom rule "acme/*" from rules/a.ts and rules/b.ts.',
    );

    const colliding = await projectWith({
      "rules/a.ts": `export default { rules: { "same-rule": {
        name: "same-rule", scope: "comment", category: "style",
        question: { instructions: "Same?" }, message: "Same.",
        buildEvidence: () => ({}),
      } } };\n`,
      "jevlint.config.ts": `export default {
        plugins: [
          { name: "acme", specifier: "./rules/a.ts" },
          { name: "acme", specifier: "./rules/a.ts" },
        ],
      };\n`,
    });
    await expect(loadConfig({ cwd: colliding })).rejects.toThrow(
      'jevlint: duplicate custom rule "acme/*" from rules/a.ts and rules/a.ts.',
    );
  });

  it("allows the same file under two entry names when the module declares no name", async () => {
    const directory = await projectWith({
      "rules/shared.ts": `export default { rules: { "shared-rule": {
        name: "shared-rule", scope: "comment", category: "style",
        question: { instructions: "Shared?" }, message: "Shared.",
        buildEvidence: () => ({ shared: true }),
      } } };\n`,
      "jevlint.config.ts": `export default {
        plugins: [
          { name: "aaa", specifier: "./rules/shared.ts" },
          { name: "bbb", specifier: "./rules/shared.ts" },
        ],
      };\n`,
    });

    const config = await loadConfig({ cwd: directory });

    expect(config.rules["aaa/shared-rule"]).toBeDefined();
    expect(config.rules["bbb/shared-rule"]).toBeDefined();
    expect(config.customEvidence?.["aaa/shared-rule"] instanceof Function).toBe(true);
    expect(config.customEvidence?.["bbb/shared-rule"] instanceof Function).toBe(true);
  });

  it("keeps separate configs from sharing custom evidence", async () => {
    const seen: string[] = [];
    const makeConfig = (tag: string): JevLintConfig => ({
      rules: {
        "acme/tag-rule": {
          scope: "function",
          category: "maintainability",
          question: { instructions: "Tagged?" },
          message: "Tagged.",
        },
      },
      customEvidence: {
        "acme/tag-rule": () => {
          seen.push(tag);
          return { tag };
        },
      },
    });

    const input = {
      filePath: "src/a.ts",
      source: `export function forward(value: string) { return value; }\n`,
      changedLines: [{ start: 1, end: 1 }],
    };
    const first = await analyzeFileWithFailures({ ...input, config: makeConfig("one") }, new FixedEvaluator());
    const second = await analyzeFileWithFailures({ ...input, config: makeConfig("two") }, new FixedEvaluator());

    expect(seen).toEqual(["one", "two"]);
    expect(first.judgments[0]?.evidence).toEqual({ tag: "one" });
    expect(second.judgments[0]?.evidence).toEqual({ tag: "two" });
  });
});
