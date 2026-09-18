import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type ConfigShadowLiteral = {
  expression: string;
  kind: "locale" | "url" | "named-limit" | "named-value";
};

export type ConfigSource = {
  filePath: string;
  excerpt: string;
};

export type SiblingConfigRead = {
  filePath: string;
  expression: string;
};

export type HardcodedConfigShadowEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  literals: ConfigShadowLiteral[];
  configSources: ConfigSource[];
  siblingConfigReads: SiblingConfigRead[];
  callers: FunctionCaller[];
};

const CONFIG_FILE_PATTERN = /config|setting|locale|i18n|\.env/i;
const CONFIG_ACCESS_PATTERN = /SiteSettings|getConfig|useLocale|process\.env|getSetting|appConfig|serverConfig/i;
const CONFIG_NAME_PATTERN = /locale|language|url|endpoint|host|domain|format|timezone|max|limit|size|timeout|ttl|expir|pageSize|retry|delay|interval|cache|key|secret/i;
const LOCALE_PATTERN = /^[a-z]{2}([-_][A-Za-z]{2})?$/;
const URL_PATTERN = /^https?:\/\//;

function literalKind(raw: string | null): "string" | "number" | "other" {
  if (raw === null) return "other";
  if (raw.startsWith('"') || raw.startsWith("'")) return "string";
  if (/^[0-9.]/.test(raw)) return "number";
  return "other";
}

function configExcerpt(source: string): string | null {
  const lines = source.split("\n");
  const matching = lines.filter((line) => CONFIG_ACCESS_PATTERN.test(line));
  if (matching.length === 0) return null;
  return matching.slice(0, 8).join("\n").slice(0, 2000);
}

export function buildHardcodedConfigShadowEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HardcodedConfigShadowEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const configSources: ConfigSource[] = [];
  for (const file of projectFiles) {
    if (file.filePath === candidate.filePath && !CONFIG_FILE_PATTERN.test(file.filePath)) continue;
    if (!CONFIG_FILE_PATTERN.test(file.filePath) && !CONFIG_ACCESS_PATTERN.test(file.source)) {
      continue;
    }
    const excerpt = configExcerpt(file.source);
    if (!excerpt) continue;
    configSources.push({ filePath: file.filePath, excerpt });
    if (configSources.length >= 6) break;
  }
  if (configSources.length === 0) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const direct = (node: { start: number; end: number }): boolean =>
    node.start >= candidate.start
    && node.end <= candidate.end
    && !nested.some((range) => range.start <= node.start && range.end >= node.end);

  const literals: ConfigShadowLiteral[] = [];
  new Visitor({
    VariableDeclarator(node) {
      if (!direct(node) || node.id.type !== "Identifier" || !node.init) return;
      const binding = node.id.name;
      if (!CONFIG_NAME_PATTERN.test(binding)) return;
      const init = node.init;
      if (init.type === "Literal") {
        const kind = literalKind(init.raw);
        if (kind === "other") return;
        const text = kind === "string" ? (init.raw ?? "").slice(1, -1) : (init.raw ?? "");
        literals.push({
          expression: owner.source.slice(node.start, node.end),
          kind: kind === "number"
            ? "named-limit"
            : LOCALE_PATTERN.test(text) || /locale|language/i.test(binding)
              ? "locale"
              : URL_PATTERN.test(text) || /url|endpoint|host|domain/i.test(binding)
                ? "url"
                : "named-value",
        });
        return;
      }
      if (init.type === "BinaryExpression" && init.operator === "*") {
        literals.push({
          expression: owner.source.slice(node.start, node.end),
          kind: "named-limit",
        });
      }
    },
    Literal(node) {
      if (!direct(node)) return;
      if (literalKind(node.raw) !== "string") return;
      const text = (node.raw ?? "").slice(1, -1);
      if (LOCALE_PATTERN.test(text) && text.length > 2) {
        literals.push({
          expression: owner.source.slice(node.start, node.end),
          kind: "locale",
        });
      } else if (URL_PATTERN.test(text)) {
        literals.push({
          expression: owner.source.slice(node.start, node.end),
          kind: "url",
        });
      }
    },
  }).visit(parsed.program);

  if (literals.length === 0) return undefined;
  const seen = new Set<string>();
  const unique = literals.filter((literal) => {
    if (seen.has(literal.expression)) return false;
    seen.add(literal.expression);
    return true;
  });
  if (unique.length === 0) return undefined;

  const siblingConfigReads: SiblingConfigRead[] = [];
  for (const file of projectFiles) {
    if (file.filePath === candidate.filePath) continue;
    const lines = file.source.split("\n");
    for (const line of lines) {
      if (CONFIG_ACCESS_PATTERN.test(line)) {
        siblingConfigReads.push({ filePath: file.filePath, expression: line.trim().slice(0, 200) });
        break;
      }
    }
    if (siblingConfigReads.length >= 8) break;
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    literals: unique,
    configSources,
    siblingConfigReads,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
