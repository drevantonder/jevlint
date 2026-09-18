import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type UserSurfaceString = {
  kind: "jsx-text" | "thrown" | "ui-call";
  text: string;
  line: number;
};

export type HandRolledPlural = {
  expression: string;
  line: number;
};

export type UnlocalizedUserStringEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  surfaceStrings: UserSurfaceString[];
  plurals: HandRolledPlural[];
  i18nInFunction: boolean;
  projectI18nFrameworks: string[];
  /** Which intent signals (see the gate comment above) the repository showed. Non-empty by construction. */
  i18nIntentSignals: string[];
  callers: FunctionCaller[];
};

const I18N_SOURCES = [
  "i18next",
  "react-i18next",
  "react-intl",
  "@lingui/core",
  "@lingui/react",
  "@lingui/macro",
  "next-intl",
  "vue-i18n",
  "@angular/localize",
  "@formatjs",
  "i18n",
];

const UI_SINK_PATTERN = /toast|alert|notify|confirm|prompt|snackbar|banner|flash/i;
const COUNT_PATTERN = /count|length|total|num\b|plural/i;
const ERROR_NAMES = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AggregateError"]);

/**
 * i18n intent signals. This rule fires ONLY when the repository shows at
 * least one of them; otherwise the candidate abstains structurally
 * (undefined evidence, no probability) instead of scoring low. An
 * English-only codebase shows none of these, so it is never lectured.
 *
 * The exact signals:
 * 1. `framework-import` — a project file imports a known i18n package
 *    (I18N_SOURCES). The team already ships an i18n framework.
 * 2. `locale-path` — a project file lives under a locale directory
 *    (LOCALE_DIR_PATTERN: locales, locale, lang, langs, languages, i18n,
 *    intl, messages, translations) or is a locale data file
 *    (LOCALE_FILE_PATTERN: *.locale.*, *.lang.*, or a locale-code JSON
 *    file such as en.json). The team already maintains locale assets.
 * 3. `project-intl-usage` — a project file calls the Intl API, renders an
 *    i18n component, invokes an i18n hook/helper, or imports a known i18n
 *    binding (I18N_BINDING_PATTERN). The team already formats through
 *    locale-aware code.
 */
const LOCALE_DIR_PATTERN = /(^|\/)(locales?|langs?|languages|i18n|intl|messages|translations)(\/|$)/;
const LOCALE_FILE_PATTERN = /(^|\.)(locale|lang)\.[\w]+$|^[a-z]{2}([_-][A-Za-z]{2})?\.json$/i;
const INTL_USAGE_PATTERN = /\bIntl\s*\.|<(FormattedMessage|Trans)[\s/>]|\b(useTranslation|useIntl|useTranslations|getTranslations|formatMessage)\s*\(/;
const I18N_BINDING_PATTERN = /^(t|useTranslation|useIntl|formatMessage|FormattedMessage)$/;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function isVisibleText(text: string): boolean {
  return /[A-Za-zÀ-ÿĀ-žЀ-џ一-鿿가-힯]/.test(text) && text.trim().length > 0;
}

function calleeName(callee: Expression): string | undefined {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression"
    && !callee.computed
    && callee.property.type === "Identifier"
  ) return callee.property.name;
  return undefined;
}

export function buildUnlocalizedUserStringEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnlocalizedUserStringEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const inScope = (start: number, end: number): boolean =>
    start >= candidate.start && end <= candidate.end
    && !nested.some((range) => range.start <= start && range.end >= end);

  const surfaceStrings: UserSurfaceString[] = [];
  const plurals: HandRolledPlural[] = [];
  let i18nInFunction = false;

  new Visitor({
    JSXText(node) {
      if (!inScope(node.start, node.end)) return;
      const text = node.value.trim().replace(/\s+/g, " ");
      if (!isVisibleText(text)) return;
      surfaceStrings.push({
        kind: "jsx-text",
        text: text.slice(0, 200),
        line: lineAt(owner.source, node.start),
      });
    },
    ThrowStatement(node) {
      if (!inScope(node.start, node.end)) return;
      if (node.argument.type !== "Literal" && node.argument.type !== "TemplateLiteral") return;
      const text = owner.source.slice(node.argument.start, node.argument.end).slice(0, 200);
      surfaceStrings.push({ kind: "thrown", text, line: lineAt(owner.source, node.start) });
    },
    NewExpression(node) {
      if (!inScope(node.start, node.end)) return;
      const callee = node.callee;
      const errorName = callee.type === "Identifier" ? callee.name : undefined;
      if (!errorName || !ERROR_NAMES.has(errorName)) return;
      const first = node.arguments[0];
      if (!first || first.type === "SpreadElement") return;
      if (first.type !== "Literal" && first.type !== "TemplateLiteral") return;
      surfaceStrings.push({
        kind: "thrown",
        text: owner.source.slice(first.start, first.end).slice(0, 200),
        line: lineAt(owner.source, node.start),
      });
    },
    CallExpression(call) {
      if (!inScope(call.start, call.end)) return;
      const nameOfCallee = calleeName(call.callee);
      if (nameOfCallee && /^(t|translate|formatMessage)$/.test(nameOfCallee)) {
        i18nInFunction = true;
        return;
      }
      if (/^Intl$/.test(nameOfCallee ?? "") || /Intl\./.test(owner.source.slice(call.start, call.start + 5))) {
        i18nInFunction = true;
      }
      if (!nameOfCallee || !UI_SINK_PATTERN.test(nameOfCallee)) return;
      const first = call.arguments[0];
      if (!first || first.type === "SpreadElement") return;
      if (first.type !== "Literal" && first.type !== "TemplateLiteral") return;
      surfaceStrings.push({
        kind: "ui-call",
        text: owner.source.slice(first.start, first.end).slice(0, 200),
        line: lineAt(owner.source, call.start),
      });
    },
    ConditionalExpression(node) {
      if (!inScope(node.start, node.end)) return;
      const test = owner.source.slice(node.test.start, node.test.end);
      const arms = [node.consequent, node.alternate];
      const bothStrings = arms.every((arm) =>
        arm.type === "Literal" || arm.type === "TemplateLiteral"
      );
      if (!bothStrings) return;
      if (!COUNT_PATTERN.test(test) && !/===\s*1|!==\s*1|==\s*1/.test(test)) return;
      plurals.push({
        expression: owner.source.slice(node.start, node.end).slice(0, 300),
        line: lineAt(owner.source, node.start),
      });
    },
  }).visit(parsed.program);

  if (surfaceStrings.length === 0 && plurals.length === 0) return undefined;

  if (!i18nInFunction) {
    i18nInFunction = moduleImports(parsed.program).some(({ local }) =>
      I18N_BINDING_PATTERN.test(local)
    );
  }

  const frameworks = new Set<string>();
  const intentSignals: string[] = [];
  for (const file of projectFiles) {
    const basename = file.filePath.split("/").pop() ?? file.filePath;
    if (LOCALE_DIR_PATTERN.test(file.filePath) || LOCALE_FILE_PATTERN.test(basename)) {
      intentSignals.push(`locale-path:${file.filePath}`);
    }
    const fileParsed = parseCached(file.filePath, file.source);
    if (fileParsed.errors.some((error) => error.severity === "Error")) continue;
    for (const { source } of moduleImports(fileParsed.program)) {
      if (I18N_SOURCES.some((framework) => source === framework || source.startsWith(`${framework}/`))) {
        frameworks.add(source);
        intentSignals.push(`framework-import:${source}`);
      }
    }
    if (
      INTL_USAGE_PATTERN.test(file.source)
      || moduleImports(fileParsed.program).some(({ local }) => I18N_BINDING_PATTERN.test(local))
    ) {
      intentSignals.push(`project-intl-usage:${file.filePath}`);
    }
  }

  // Intent gate: no i18n intent anywhere in the repo means the team ships
  // English-only by decision. Abstain structurally instead of scoring.
  if (intentSignals.length === 0) {
    return undefined;
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    surfaceStrings,
    plurals,
    i18nInFunction,
    projectI18nFrameworks: [...frameworks],
    i18nIntentSignals: [...new Set(intentSignals)].slice(0, 20),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
