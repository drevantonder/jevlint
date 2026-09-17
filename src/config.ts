import { access } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { createJiti } from "jiti";
import { z } from "zod";
import { defaultConfig } from "./defaults.js";
import type { JevLintConfig, RuleConfig, RuleQuestion, UserConfig } from "./types.js";

const CONFIG_FILES = [
  "jevlint.config.ts",
  "jevlint.config.mts",
  "jevlint.config.js",
  "jevlint.config.mjs",
  "jevlint.config.cjs",
];

const entryTypeSchema = z.union([
  z.string(),
  z.record(z.string(), z.json()),
  z.array(z.json()),
  z.null(),
]);

const ruleConfigSchema = z.object({
  scope: z.enum(["comment", "function", "abstraction", "change", "module"]),
  question: z.object({
    instructions: entryTypeSchema,
    criteria: z.object({
      true: entryTypeSchema.optional(),
      false: entryTypeSchema.optional(),
    }).optional(),
  }).strict(),
  message: z.string().min(1),
}).strict().transform((parsed): RuleConfig => {
  const question: RuleQuestion = { instructions: parsed.question.instructions };
  if (parsed.question.criteria !== undefined) {
    const criteria: NonNullable<RuleQuestion["criteria"]> = {};
    if (parsed.question.criteria.true !== undefined) criteria.true = parsed.question.criteria.true;
    if (parsed.question.criteria.false !== undefined) criteria.false = parsed.question.criteria.false;
    question.criteria = criteria;
  }
  return {
    scope: parsed.scope,
    question,
    message: parsed.message,
  };
});

const userConfigSchema = z.object({
  rules: z.record(z.string(), z.union([z.literal("off"), ruleConfigSchema])).optional(),
});

export { defaultConfig } from "./defaults.js";

export function defineConfig(config: UserConfig): UserConfig {
  return config;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function mergeConfig(userConfig: UserConfig): JevLintConfig {
  const rules = new Map(Object.entries(defaultConfig.rules));
  for (const [ruleId, setting] of Object.entries(userConfig.rules ?? {})) {
    if (setting === "off") {
      rules.delete(ruleId);
    } else {
      rules.set(ruleId, setting);
    }
  }
  return { rules: Object.fromEntries(rules) };
}

export interface LoadConfigOptions {
  cwd: string;
  configPath?: string;
}

export async function loadConfig(options: LoadConfigOptions): Promise<JevLintConfig> {
  let configPath: string | undefined;
  if (options.configPath) {
    configPath = isAbsolute(options.configPath)
      ? options.configPath
      : resolve(options.cwd, options.configPath);
    if (!(await exists(configPath))) throw new Error(`Config file not found: ${configPath}`);
  } else {
    for (const name of CONFIG_FILES) {
      const possiblePath = join(options.cwd, name);
      if (await exists(possiblePath)) {
        configPath = possiblePath;
        break;
      }
    }
  }

  if (!configPath) return { rules: { ...defaultConfig.rules } };

  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const importedConfig = await jiti.import<unknown>(configPath, { default: true });
  const parsedConfig = userConfigSchema.parse(importedConfig);
  return mergeConfig(parsedConfig.rules === undefined ? {} : { rules: parsedConfig.rules });
}
