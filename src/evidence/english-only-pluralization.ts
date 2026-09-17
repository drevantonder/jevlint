import { parseSync, Visitor } from "oxc-parser";
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

export type PluralBranch = {
  expression: string;
  test: string;
  line: number;
};

export type EnglishOnlyPluralizationEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  pluralBranches: PluralBranch[];
  usesPluralRules: boolean;
  projectI18nFrameworks: string[];
  localeReach: string[];
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

const COUNT_TEST_PATTERN = /===\s*1|!==\s*1|==\s*1|>\s*1|<\s*2|%|count|length|total|num\b|plural/i;
const I18N_ARM_PATTERN = /\bt\s*\(|formatMessage\s*\(|\$t\s*\(|intl\.formatMessage|messages?\.|translations?\./;
const I18N_CALL_PATTERN = /^(t|translate|formatMessage|\$t|intl\.formatMessage|i18n\.t)$/;
const LOCALE_FILE_PATTERN = /(^|\/)(locales?|messages?|translations?|i18n)(\/|_|\.)|\.(po|pot|xliff|xlf)$/i;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function calleeName(callee: Expression, source: string): string {
  return source.slice(callee.start, callee.end);
}

function armThroughI18nKey(arm: Expression, source: string): boolean {
  if (arm.type === "CallExpression") {
    return I18N_CALL_PATTERN.test(calleeName(arm.callee, source));
  }
  if (arm.type === "MemberExpression" || arm.type === "Identifier") {
    return /messages?|translations?|localeStrings|strings\./i.test(source.slice(arm.start, arm.end));
  }
  return false;
}

export function buildEnglishOnlyPluralizationEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): EnglishOnlyPluralizationEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const inScope = (start: number, end: number): boolean =>
    start >= candidate.start && end <= candidate.end
    && !nested.some((range) => range.start <= start && range.end >= end);

  const pluralBranches: PluralBranch[] = [];
  let usesPluralRules = false;

  new Visitor({
    ConditionalExpression(node) {
      if (!inScope(node.start, node.end)) return;
      const test = owner.source.slice(node.test.start, node.test.end);
      if (!COUNT_TEST_PATTERN.test(test)) return;
      if (
        !armThroughI18nKey(node.consequent, owner.source)
        && !armThroughI18nKey(node.alternate, owner.source)
      ) return;
      pluralBranches.push({
        expression: owner.source.slice(node.start, node.end).slice(0, 300),
        test: test.slice(0, 120),
        line: lineAt(owner.source, node.start),
      });
    },
    IfStatement(node) {
      if (!inScope(node.start, node.end)) return;
      const test = owner.source.slice(node.test.start, node.test.end);
      if (!COUNT_TEST_PATTERN.test(test)) return;
      const armsEnd = node.alternate ? node.alternate.end : node.consequent.end;
      const armsText = owner.source.slice(node.consequent.start, armsEnd);
      if (!I18N_ARM_PATTERN.test(armsText)) return;
      pluralBranches.push({
        expression: owner.source.slice(node.start, node.end).slice(0, 300),
        test: test.slice(0, 120),
        line: lineAt(owner.source, node.start),
      });
    },
    CallExpression(call) {
      if (!inScope(call.start, call.end)) return;
      const text = owner.source.slice(call.callee.start, call.callee.end);
      if (/PluralRules|selectOrdinal|plural/i.test(text)) usesPluralRules = true;
    },
  }).visit(parsed.program);

  if (pluralBranches.length === 0) return undefined;

  const candidateText = owner.source.slice(candidate.start, candidate.end);
  if (/new\s+Intl\.PluralRules|Intl\.PluralRules\s*\(|\{\s*count[^}]*\}|plural:\s*\{/i.test(candidateText)) {
    usesPluralRules = true;
  }

  const frameworks = new Set<string>();
  const localeReach: string[] = [];
  for (const file of projectFiles) {
    if (LOCALE_FILE_PATTERN.test(file.filePath)) {
      if (localeReach.length < 6) localeReach.push(file.filePath);
    }
    const fileParsed = parseSync(file.filePath, file.source, { range: true });
    if (fileParsed.errors.some((error) => error.severity === "Error")) continue;
    for (const { source } of moduleImports(fileParsed.program)) {
      if (I18N_SOURCES.some((framework) => source === framework || source.startsWith(`${framework}/`))) {
        frameworks.add(source);
      }
    }
  }

  if (frameworks.size === 0 && localeReach.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    pluralBranches,
    usesPluralRules,
    projectI18nFrameworks: [...frameworks],
    localeReach,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
