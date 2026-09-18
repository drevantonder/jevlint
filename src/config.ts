import { access } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createJiti } from "jiti";
import { z } from "zod";
import { defaultConfig } from "./defaults.js";
import type {
  CandidateKind,
  CustomEvidenceBuilder,
  CustomRuleDescriptor,
  JevLintConfig,
  PluginContainer,
  PluginEntry,
  RuleConfig,
  RuleQuestion,
  UserConfig,
} from "./types.js";

const CONFIG_FILES = [
  "jevlint.config.ts",
  "jevlint.config.mts",
  "jevlint.config.js",
  "jevlint.config.mjs",
  "jevlint.config.cjs",
];

const CANDIDATE_KINDS: CandidateKind[] = ["comment", "function", "abstraction", "change", "module"];
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const RULE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]+$/;

const entryTypeSchema = z.union([
  z.string(),
  z.record(z.string(), z.json()),
  z.array(z.json()),
  z.null(),
]);

const questionSchema = z.object({
  instructions: entryTypeSchema,
  criteria: z.object({
    true: entryTypeSchema.optional(),
    false: entryTypeSchema.optional(),
  }).optional(),
}).strict();

const messageSchema = z.string().min(1);

const ruleConfigSchema = z.object({
  scope: z.enum(["comment", "function", "abstraction", "change", "module"]),
  question: questionSchema,
  message: messageSchema,
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
  plugins: z.array(z.unknown()).optional(),
  rules: z.record(z.string(), z.union([z.literal("off"), ruleConfigSchema])).optional(),
});

export { defaultConfig } from "./defaults.js";

export function defineConfig(config: UserConfig): UserConfig {
  return config;
}

export function defineRule(rule: CustomRuleDescriptor): CustomRuleDescriptor {
  return rule;
}

export function definePlugin(plugin: PluginContainer): PluginContainer {
  return plugin;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function isLocalSpecifier(specifier: string): boolean {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function escapesRoot(root: string, resolved: string): boolean {
  const rel = relative(root, resolved);
  return rel === "" || rel === ".." || rel.startsWith(`..${"/"}`) || isAbsolute(rel);
}

function levenshtein(left: string, right: string): number {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const table: number[][] = Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => (row === 0 ? column : column === 0 ? row : 0)),
  );
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const substitution = (table[row - 1]?.[column - 1] ?? 0) + (left[row - 1] === right[column - 1] ? 0 : 1);
      table[row]![column] = Math.min(
        (table[row - 1]?.[column] ?? 0) + 1,
        (table[row]?.[column - 1] ?? 0) + 1,
        substitution,
      );
    }
  }
  return table[left.length]?.[right.length] ?? Number.MAX_SAFE_INTEGER;
}

function closestKey(knownKeys: string[], unknownKey: string): string {
  let best = [...knownKeys].sort((left, right) => left.localeCompare(right))[0] ?? unknownKey;
  let bestDistance = Number.MAX_SAFE_INTEGER;
  for (const key of knownKeys) {
    const distance = levenshtein(unknownKey, key);
    if (distance < bestDistance || (distance === bestDistance && key.localeCompare(best) < 0)) {
      best = key;
      bestDistance = distance;
    }
  }
  return best;
}

interface LoadedCustomRule {
  key: string;
  rule: RuleConfig;
  builder: CustomEvidenceBuilder;
  relpath: string;
}

function zodIssueInPlainWords(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "invalid value";
  const path = issue.path.map(String).join(".");
  return path === "" ? issue.message : `${path}: ${issue.message}`;
}

interface ValidatedCustomRule {
  rule: RuleConfig;
  builder: CustomEvidenceBuilder;
}

const pluginContainerSchema = z.object({
  name: z.string().optional(),
  rules: z.record(z.string(), z.custom<CustomRuleDescriptor>(() => true)),
});

const pluginDescriptorSchema = z.custom<CustomRuleDescriptor>(() => true);

function validateRuleDescriptor(
  pluginName: string,
  suffix: string,
  relpath: string,
  raw: CustomRuleDescriptor,
): ValidatedCustomRule {
  if (raw === null || !(raw instanceof Object)) {
    throw new Error(`jevlint: plugin "${pluginName}" rule "${suffix}": expected an object (in ${relpath}).`);
  }
  const descriptorName = raw.name ?? "?";
  if (!RULE_NAME_PATTERN.test(descriptorName) || descriptorName.startsWith("jev")) {
    throw new Error(
      `jevlint: plugin "${pluginName}" rule "${suffix}": name must use lowercase letters, digits, and hyphens, not starting with "jev" (in ${relpath}).`,
    );
  }
  if (descriptorName !== suffix) {
    throw new Error(
      `jevlint: plugin "${pluginName}" rule "${suffix}": name "${descriptorName}" does not match its registration key (in ${relpath}).`,
    );
  }
  if (!CANDIDATE_KINDS.includes(raw.scope)) {
    throw new Error(
      `jevlint: plugin "${pluginName}" rule "${suffix}": scope must be one of comment, function, abstraction, change, module.`,
    );
  }
  const builder: CustomEvidenceBuilder = raw.buildEvidence;
  if (!(builder instanceof Function) || builder.constructor.name === "AsyncFunction") {
    throw new Error(
      `jevlint: plugin "${pluginName}" rule "${suffix}": evidence builder must be a synchronous function.`,
    );
  }
  const parsed = z.object({
    scope: z.enum(["comment", "function", "abstraction", "change", "module"]),
    question: questionSchema,
    message: messageSchema,
  }).strict().safeParse({ scope: raw.scope, question: raw.question, message: raw.message });
  if (!parsed.success) {
    throw new Error(
      `jevlint: plugin "${pluginName}" rule "${suffix}": ${zodIssueInPlainWords(parsed.error)} (in ${relpath}).`,
    );
  }
  const question: RuleQuestion = { instructions: parsed.data.question.instructions };
  if (parsed.data.question.criteria !== undefined) {
    const criteria: NonNullable<RuleQuestion["criteria"]> = {};
    if (parsed.data.question.criteria.true !== undefined) criteria.true = parsed.data.question.criteria.true;
    if (parsed.data.question.criteria.false !== undefined) criteria.false = parsed.data.question.criteria.false;
    question.criteria = criteria;
  }
  return {
    rule: { scope: parsed.data.scope, question, message: parsed.data.message },
    builder,
  };
}

async function loadPluginRules(
  entries: PluginEntry[],
  configDir: string,
  projectRoot: string,
  relconfig: string,
): Promise<LoadedCustomRule[]> {
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const loaded: LoadedCustomRule[] = [];
  const seenNames = new Map<string, string>();

  for (const entry of entries) {
    const { name, specifier } = entry;
    if (!PLUGIN_NAME_PATTERN.test(name) || name === "jev") {
      throw new Error(
        `jevlint: plugin name "${name}" is reserved or invalid (lowercase letters, digits, hyphens; not "jev").`,
      );
    }
    if (!isLocalSpecifier(specifier)) {
      throw new Error(
        `jevlint: plugin "${name}" specifier must be a project-local relative path, got "${specifier}".`,
      );
    }
    const resolved = resolve(configDir, specifier);
    const relpath = relative(projectRoot, resolved);
    if (escapesRoot(projectRoot, resolved)) {
      throw new Error(
        `jevlint: plugin "${name}" specifier must be a project-local relative path, got "${specifier}".`,
      );
    }
    if (!(await exists(resolved))) {
      throw new Error(`jevlint: plugin "${name}" not found at ${relpath} (relative to ${relconfig}).`);
    }
    const previous = seenNames.get(name);
    if (previous !== undefined) {
      throw new Error(`jevlint: duplicate custom rule "${name}/*" from ${previous} and ${relpath}.`);
    }
    seenNames.set(name, relpath);

    const exported = await jiti.import<unknown>(resolved, { default: true });
    const container = pluginContainerSchema.safeParse(exported).data;
    if (container !== undefined) {
      if (container.name !== undefined && container.name !== name) {
        throw new Error(`jevlint: plugin at ${relpath} declares name "${container.name}" but is registered as "${name}".`);
      }
      for (const [suffix, raw] of Object.entries(container.rules)) {
        const { rule, builder } = validateRuleDescriptor(name, suffix, relpath, raw);
        loaded.push({ key: `${name}/${suffix}`, rule, builder, relpath });
      }
    } else {
      const single = pluginDescriptorSchema.parse(exported);
      const suffix = single.name ?? "?";
      const { rule, builder } = validateRuleDescriptor(name, suffix, relpath, single);
      loaded.push({ key: `${name}/${suffix}`, rule, builder, relpath });
    }
  }

  const seenKeys = new Map<string, string>();
  for (const rule of loaded) {
    if (rule.key.startsWith("jev/")) {
      throw new Error(`jevlint: custom rule key "${rule.key}" is reserved (jev/ is bundled-only).`);
    }
    const previous = seenKeys.get(rule.key);
    if (previous !== undefined) {
      throw new Error(`jevlint: duplicate custom rule "${rule.key}" from ${previous} and ${rule.relpath}.`);
    }
    seenKeys.set(rule.key, rule.relpath);
  }
  return loaded;
}

function mergeConfig(
  userRules: Record<string, RuleConfig | "off"> | undefined,
  customRules: LoadedCustomRule[],
): JevLintConfig {
  const rules = new Map<string, RuleConfig>(Object.entries(defaultConfig.rules));
  const customEvidence: Record<string, CustomEvidenceBuilder> = {};
  for (const custom of customRules) {
    rules.set(custom.key, custom.rule);
    customEvidence[custom.key] = custom.builder;
  }
  const knownKeys = new Set(rules.keys());
  for (const [ruleId, setting] of Object.entries(userRules ?? {})) {
    if (!knownKeys.has(ruleId)) {
      throw new Error(`jevlint: unknown rule "${ruleId}". Did you mean "${closestKey([...knownKeys], ruleId)}"?`);
    }
    if (setting === "off") {
      rules.delete(ruleId);
      delete customEvidence[ruleId];
    } else {
      rules.set(ruleId, setting);
    }
  }
  const config: JevLintConfig = { rules: Object.fromEntries(rules) };
  if (Object.keys(customEvidence).length > 0) config.customEvidence = customEvidence;
  return config;
}

export interface LoadConfigOptions {
  cwd: string;
  configPath?: string;
}

const pluginEntryFieldsSchema = z.record(z.string(), z.unknown());

function normalizePluginEntries(raw: z.output<typeof userConfigSchema>["plugins"]): PluginEntry[] {
  if (raw === undefined) return [];
  return raw.map((entry): PluginEntry => {
    const fields = pluginEntryFieldsSchema.safeParse(entry).data ?? {};
    return {
      name: z.string().safeParse(fields["name"]).data ?? "?",
      specifier: z.string().safeParse(fields["specifier"]).data ?? "?",
    };
  });
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
  const plugins = normalizePluginEntries(parsedConfig.plugins);
  const configDir = dirname(configPath);
  const relconfig = relative(options.cwd, configPath);
  const customRules = await loadPluginRules(plugins, configDir, options.cwd, relconfig);
  return mergeConfig(parsedConfig.rules, customRules);
}
