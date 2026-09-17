import { parseSync, Visitor } from "oxc-parser";
import type { IfStatement, Program } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";

const MAX_ADDED = 10;
const MAX_MIRRORS = 12;
const MAX_LITERALS = 20;
const MAX_EXCERPT_CHARS = 500;

export type AddedCaseKind = "switch-case" | "if-branch" | "union-member" | "enum-member";

export type AddedCase = {
  filePath: string;
  kind: AddedCaseKind;
  literal: string;
  discriminant: string;
  line: number;
  excerpt: string;
};

export type MirrorSite = {
  filePath: string;
  kind: "switch" | "if-chain";
  discriminant: string;
  handledLiterals: string[];
  handlesAdded: boolean;
  exhaustive: boolean;
  excerpt: string;
};

export type ChangeAmplifierCaseEvidence = {
  anchorFile: string;
  coverage: {
    totalFiles: number;
    comparedFiles: number;
  };
  addedCases: AddedCase[];
  mirrors: MirrorSite[];
};

type LiteralSet = {
  literals: Set<string>;
  lines: Map<string, number>;
  excerpts: Map<string, string>;
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function changedLineSet(change: SourceFile): Set<number> {
  const lines = new Set<number>();
  for (const range of change.changedLines) {
    for (let line = range.start; line <= range.end; line += 1) lines.add(line);
  }
  return lines;
}

function normalizeLiteral(text: string): string | undefined {
  const trimmed = text.trim();
  const stringMatch = /^["']([^"']*)["']$/.exec(trimmed);
  if (stringMatch?.[1] !== undefined) return stringMatch[1];
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return trimmed;
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return trimmed;
  return undefined;
}

function baseOf(text: string): string | undefined {
  const match = /([\w$]+(?:\.[\w$]+|\[['"][^'"]+['"]\]){0,3})/.exec(text.trim());
  return match?.[1]?.replace(/\s+/g, "");
}

function switchLiterals(
  program: Program,
  source: string,
): Map<string, LiteralSet> {
  const result = new Map<string, LiteralSet>();
  new Visitor({
    SwitchStatement(node) {
      const discriminant = source.slice(node.discriminant.start, node.discriminant.end);
      const base = baseOf(discriminant);
      if (!base) return;
      let entry = result.get(base);
      if (!entry) {
        entry = { literals: new Set(), lines: new Map(), excerpts: new Map() };
        result.set(base, entry);
      }
      for (const caseNode of node.cases) {
        if (!caseNode.test) continue;
        const test = source.slice(caseNode.test.start, caseNode.test.end);
        const literal = normalizeLiteral(test);
        if (!literal || entry.literals.has(literal)) continue;
        entry.literals.add(literal);
        entry.lines.set(literal, lineAt(source, caseNode.start));
        entry.excerpts.set(
          literal,
          `case ${test}: ${source.slice(caseNode.start, caseNode.end).slice(test.length + 6).trim().slice(0, 160)}`,
        );
      }
    },
  }).visit(program);
  return result;
}

function ifChainLiterals(
  program: Program,
  source: string,
): Map<string, LiteralSet> {
  const result = new Map<string, LiteralSet>();
  new Visitor({
    IfStatement(node) {
      const chained = new Map<string, { literal: string; line: number; test: string }[]>();
      let current: IfStatement | undefined = node;
      while (current) {
        const testSource = source.slice(current.test.start, current.test.end);
        const forward = /([\w$][\w$.[\]'"]*?)\s*===?\s*(["'][^"']*["']|-?\d+(?:\.\d+)?)/.exec(testSource);
        const reversed = /(["'][^"']*["']|-?\d+(?:\.\d+)?)\s*===?\s*([\w$][\w$.[\]'"]*)/.exec(testSource);
        const baseSource = forward?.[1] ?? reversed?.[2];
        const literalSource = forward?.[2] ?? reversed?.[1];
        if (!baseSource || !literalSource) break;
        const base = baseOf(baseSource);
        const literal = normalizeLiteral(literalSource);
        if (!base || !literal) break;
        const arms = chained.get(base) ?? [];
        arms.push({ literal, line: lineAt(source, current.start), test: testSource });
        chained.set(base, arms);
        const alternate: IfStatement["alternate"] = current.alternate;
        current = alternate?.type === "IfStatement" ? alternate : undefined;
      }
      for (const [base, arms] of chained) {
        if (arms.length < 1) continue;
        let entry = result.get(base);
        if (!entry) {
          entry = { literals: new Set(), lines: new Map(), excerpts: new Map() };
          result.set(base, entry);
        }
        for (const arm of arms) {
          if (entry.literals.has(arm.literal)) continue;
          entry.literals.add(arm.literal);
          entry.lines.set(arm.literal, arm.line);
          entry.excerpts.set(arm.literal, `if (${arm.test})`.slice(0, 200));
        }
      }
    },
  }).visit(program);
  return result;
}

function unionLiterals(
  program: Program,
  source: string,
): Map<string, LiteralSet> {
  const result = new Map<string, LiteralSet>();
  new Visitor({
    TSTypeAliasDeclaration(node) {
      if (node.typeAnnotation.type !== "TSUnionType") return;
      const name = node.id.name;
      let entry = result.get(name);
      if (!entry) {
        entry = { literals: new Set(), lines: new Map(), excerpts: new Map() };
        result.set(name, entry);
      }
      for (const member of node.typeAnnotation.types) {
        const text = source.slice(member.start, member.end);
        const literal = normalizeLiteral(text);
        if (!literal || entry.literals.has(literal)) continue;
        entry.literals.add(literal);
        entry.lines.set(literal, lineAt(source, member.start));
        entry.excerpts.set(literal, `type ${name} = ... | ${text}`.slice(0, 200));
      }
    },
    TSEnumDeclaration(node) {
      const name = node.id.name;
      let entry = result.get(name);
      if (!entry) {
        entry = { literals: new Set(), lines: new Map(), excerpts: new Map() };
        result.set(name, entry);
      }
      for (const member of node.body.members) {
        const id = member.id;
        const literal = id.type === "Identifier" ? id.name : source.slice(id.start, id.end);
        const normalized = normalizeLiteral(literal);
        if (!normalized || entry.literals.has(normalized)) continue;
        entry.literals.add(normalized);
        entry.lines.set(normalized, lineAt(source, member.start));
        entry.excerpts.set(normalized, `enum ${name} { ... ${literal} ... }`.slice(0, 200));
      }
    },
  }).visit(program);
  return result;
}

function diffSets(
  before: Map<string, LiteralSet>,
  after: Map<string, LiteralSet>,
  changed: Set<number>,
): { discriminant: string; literal: string; line: number; excerpt: string }[] {
  const added: { discriminant: string; literal: string; line: number; excerpt: string }[] = [];
  for (const [discriminant, afterSet] of after) {
    const beforeSet = before.get(discriminant);
    for (const literal of afterSet.literals) {
      if (beforeSet?.literals.has(literal)) continue;
      const line = afterSet.lines.get(literal) ?? 0;
      if (!changed.has(line)) continue;
      added.push({
        discriminant,
        literal,
        line,
        excerpt: afterSet.excerpts.get(literal) ?? literal,
      });
    }
  }
  return added;
}

function mirrorExhaustive(source: string, start: number, end: number): boolean {
  const body = source.slice(start, end);
  return /\bnever\b/.test(body)
    || /assertNever|assertExhaustive|exhaustiveCheck/.test(body);
}

function collectMirrors(
  filePath: string,
  source: string,
  wantedBases: Set<string>,
  wantedLiterals: Set<string>,
): MirrorSite[] {
  const mirrors: MirrorSite[] = [];
  const seenIfChains = new Set<string>();
  const parsed = parseSync(filePath, source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return mirrors;
  new Visitor({
    SwitchStatement(node) {
      const discriminant = source.slice(node.discriminant.start, node.discriminant.end);
      const base = baseOf(discriminant);
      if (!base) return;
      const handled: string[] = [];
      for (const caseNode of node.cases) {
        if (!caseNode.test) continue;
        const literal = normalizeLiteral(source.slice(caseNode.test.start, caseNode.test.end));
        if (literal && !handled.includes(literal)) handled.push(literal);
      }
      const sharesBase = wantedBases.has(base);
      const sharesLiteral = handled.some((literal) => wantedLiterals.has(literal));
      if (!sharesBase && !sharesLiteral) return;
      mirrors.push({
        filePath,
        kind: "switch",
        discriminant: base,
        handledLiterals: handled.slice(0, MAX_LITERALS),
        handlesAdded: false,
        exhaustive: mirrorExhaustive(source, node.start, node.end),
        excerpt: `switch (${discriminant}) { ${handled.join(" | ")} }`.slice(0, MAX_EXCERPT_CHARS),
      });
    },
    IfStatement(node) {
      const handled: string[] = [];
      let base: string | undefined;
      let current: IfStatement | undefined = node;
      while (current) {
        const testSource = source.slice(current.test.start, current.test.end);
        const forward = /([\w$][\w$.[\]'"]*?)\s*===?\s*(["'][^"']*["']|-?\d+(?:\.\d+)?)/.exec(testSource);
        const reversed = /(["'][^"']*["']|-?\d+(?:\.\d+)?)\s*===?\s*([\w$][\w$.[\]'"]*)/.exec(testSource);
        const baseSource = forward?.[1] ?? reversed?.[2];
        const literalSource = forward?.[2] ?? reversed?.[1];
        if (!baseSource || !literalSource) break;
        const armBase = baseOf(baseSource);
        const literal = normalizeLiteral(literalSource);
        if (!armBase || !literal) break;
        if (base === undefined) base = armBase;
        if (armBase !== base) break;
        if (!handled.includes(literal)) handled.push(literal);
        const alternate: IfStatement["alternate"] = current.alternate;
        current = alternate?.type === "IfStatement" ? alternate : undefined;
      }
      if (!base || handled.length === 0) return;
      const sharesBase = wantedBases.has(base);
      const sharesLiteral = handled.some((literal) => wantedLiterals.has(literal));
      if (!sharesBase && !sharesLiteral) return;
      const key = `${base}::${handled.join("|")}`;
      if (seenIfChains.has(key)) return;
      seenIfChains.add(key);
      mirrors.push({
        filePath,
        kind: "if-chain",
        discriminant: base,
        handledLiterals: handled.slice(0, MAX_LITERALS),
        handlesAdded: false,
        exhaustive: hasTerminalElse(node.alternate),
        excerpt: `if-chain over ${base}: ${handled.join(" | ")}`.slice(0, MAX_EXCERPT_CHARS),
      });
    },
  }).visit(parsed.program);
  return mirrors;
}

function hasTerminalElse(alternate: IfStatement["alternate"]): boolean {
  if (!alternate) return false;
  if (alternate.type === "IfStatement") {
    return hasTerminalElse(alternate.alternate);
  }
  return true;
}

export function buildChangeAmplifierCaseEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): ChangeAmplifierCaseEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  if (changes.length === 0) return undefined;

  const addedCases: AddedCase[] = [];
  let compared = 0;
  const wantedBases = new Set<string>();
  const wantedLiterals = new Set<string>();
  const unionMemberSets = new Map<string, Set<string>>();

  const ordered = [...changes].sort((left, right) => {
    if (left.filePath === candidate.filePath) return -1;
    if (right.filePath === candidate.filePath) return 1;
    return left.filePath.localeCompare(right.filePath);
  });

  for (const change of ordered) {
    if (addedCases.length >= MAX_ADDED) break;
    if (change.oldSource === null) continue;
    const beforeParsed = parseSync(change.filePath, change.oldSource, { range: true });
    const afterParsed = parseSync(change.filePath, change.source, { range: true });
    if (
      beforeParsed.errors.some((error) => error.severity === "Error")
      || afterParsed.errors.some((error) => error.severity === "Error")
    ) continue;
    compared += 1;
    const changed = changedLineSet(change);

    for (const added of diffSets(
      switchLiterals(beforeParsed.program, change.oldSource),
      switchLiterals(afterParsed.program, change.source),
      changed,
    )) {
      if (addedCases.length >= MAX_ADDED) break;
      addedCases.push({ filePath: change.filePath, kind: "switch-case", ...added });
      wantedBases.add(added.discriminant);
      wantedLiterals.add(added.literal);
    }
    for (const added of diffSets(
      ifChainLiterals(beforeParsed.program, change.oldSource),
      ifChainLiterals(afterParsed.program, change.source),
      changed,
    )) {
      if (addedCases.length >= MAX_ADDED) break;
      if (addedCases.some((existing) => existing.literal === added.literal)) continue;
      addedCases.push({ filePath: change.filePath, kind: "if-branch", ...added });
      wantedBases.add(added.discriminant);
      wantedLiterals.add(added.literal);
    }
    const beforeUnions = unionLiterals(beforeParsed.program, change.oldSource);
    const afterUnions = unionLiterals(afterParsed.program, change.source);
    for (const added of diffSets(beforeUnions, afterUnions, changed)) {
      if (addedCases.length >= MAX_ADDED) break;
      const isEnum = change.source.includes(`enum ${added.discriminant}`);
      addedCases.push({
        filePath: change.filePath,
        kind: isEnum ? "enum-member" : "union-member",
        ...added,
      });
      const fullSet = afterUnions.get(added.discriminant)?.literals ?? new Set([added.literal]);
      unionMemberSets.set(added.discriminant, fullSet);
      for (const literal of fullSet) wantedLiterals.add(literal);
    }
  }

  if (addedCases.length === 0) return undefined;

  const mirrors: MirrorSite[] = [];
  for (const file of projectFiles) {
    if (mirrors.length >= MAX_MIRRORS) break;
    for (const mirror of collectMirrors(file.filePath, file.source, wantedBases, wantedLiterals)) {
      if (mirrors.length >= MAX_MIRRORS) break;
      mirror.handlesAdded = mirror.handledLiterals.some((literal) =>
        addedCases.some((added) => added.literal === literal)
      );
      mirrors.push(mirror);
    }
  }

  if (mirrors.length === 0) return undefined;

  return {
    anchorFile: candidate.filePath,
    coverage: { totalFiles: changes.length, comparedFiles: compared },
    addedCases,
    mirrors,
  };
}
