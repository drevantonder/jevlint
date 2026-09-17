import { parseSync } from "oxc-parser";
import type { Class, Program } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { findModuleImporters } from "./repository.js";

const MAX_EXPANSIONS = 10;
const MAX_IMPORTER_FILES = 8;
const MAX_DECL_CHARS = 300;

export type MutableExpansionKind =
  | "export-let"
  | "export-var"
  | "mutable-class-field"
  | "class-setter"
  | "singleton-mutation-method";

export type MutableExpansion = {
  filePath: string;
  kind: MutableExpansionKind;
  name: string;
  line: number;
  declaration: string;
};

export type TouchedModuleImporters = {
  filePath: string;
  importerCount: number;
  importerFiles: string[];
};

export type MutableSurfaceExpansionEvidence = {
  anchorFile: string;
  coverage: {
    totalFiles: number;
    comparedFiles: number;
  };
  expansions: MutableExpansion[];
  importers: TouchedModuleImporters[];
};

type ClassBodyMember = Class["body"]["body"][number];

type SurfaceKey = {
  key: string;
  kind: MutableExpansionKind;
  name: string;
  line: number;
  declaration: string;
};

const MUTATION_METHOD_PATTERN = /^(set|add|update|mutate|reset|push|delete|remove|clear|put|patch|assign|replace|insert|write|save|commit|apply|register|unregister|subscribe|publish|dispatch)[A-Z_]/;

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

function memberKey(member: ClassBodyMember, source: string): string | undefined {
  if (member.type !== "PropertyDefinition" && member.type !== "MethodDefinition") return undefined;
  const key = member.key;
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal") {
    const raw = source.slice(key.start, key.end);
    if (raw.length >= 2 && (raw.startsWith("\"") || raw.startsWith("'"))) return raw.slice(1, -1);
  }
  return undefined;
}

function exportedLocalNames(program: Program): Set<string> {
  const names = new Set<string>();
  for (const statement of program.body) {
    if (statement.type === "ExportNamedDeclaration") {
      const declaration = statement.declaration;
      if (declaration?.type === "VariableDeclaration") {
        for (const item of declaration.declarations) {
          if (item.id.type === "Identifier") names.add(item.id.name);
        }
      } else if (
        declaration?.type === "ClassDeclaration"
        || declaration?.type === "FunctionDeclaration"
      ) {
        if (declaration.id?.name) names.add(declaration.id.name);
      }
      for (const specifier of statement.specifiers) {
        if (specifier.local.type === "Identifier") names.add(specifier.local.name);
      }
    } else if (statement.type === "ExportDefaultDeclaration") {
      const declaration = statement.declaration;
      if (!declaration) continue;
      if (declaration.type === "ClassDeclaration" && declaration.id?.name) {
        names.add(declaration.id.name);
      }
      if (declaration.type === "Identifier") names.add(declaration.name);
    }
  }
  return names;
}

function mutableSurface(program: Program, source: string): SurfaceKey[] {
  const surface: SurfaceKey[] = [];
  const exported = exportedLocalNames(program);
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (declaration?.type === "VariableDeclaration") {
      if (declaration.kind !== "let" && declaration.kind !== "var") continue;
      for (const item of declaration.declarations) {
        if (item.id.type !== "Identifier") continue;
        const name = item.id.name;
        const isExported = statement.type === "ExportNamedDeclaration" || exported.has(name);
        if (!isExported) continue;
        surface.push({
          key: `binding:${name}`,
          kind: declaration.kind === "let" ? "export-let" : "export-var",
          name,
          line: lineAt(source, item.start),
          declaration: source.slice(declaration.start, declaration.end).slice(0, MAX_DECL_CHARS),
        });
      }
      continue;
    }
    const classNode = declaration?.type === "ClassDeclaration"
      ? declaration
      : statement.type === "ExportDefaultDeclaration" && statement.declaration?.type === "ClassDeclaration"
        ? statement.declaration
        : undefined;
    if (!classNode) continue;
    const className = classNode.id?.name ?? "default";
    const isExported = statement.type === "ExportNamedDeclaration"
      || statement.type === "ExportDefaultDeclaration"
      || (classNode.id?.name !== undefined && exported.has(classNode.id.name));
    if (!isExported) continue;
    for (const member of classNode.body.body) {
      if (member.type === "PropertyDefinition") {
        if (member.readonly || member.declare) continue;
        const name = memberKey(member, source);
        if (!name) continue;
        surface.push({
          key: `class:${className}.${name}#field`,
          kind: "mutable-class-field",
          name: `${className}.${name}`,
          line: lineAt(source, member.start),
          declaration: source.slice(member.start, member.end).slice(0, MAX_DECL_CHARS),
        });
        continue;
      }
      if (member.type !== "MethodDefinition") continue;
      if (member.kind === "constructor") continue;
      const name = memberKey(member, source);
      if (!name) continue;
      if (member.kind === "set") {
        surface.push({
          key: `class:${className}.${name}#set`,
          kind: "class-setter",
          name: `${className}.${name}`,
          line: lineAt(source, member.start),
          declaration: source.slice(member.start, member.end).slice(0, MAX_DECL_CHARS),
        });
        continue;
      }
      if (member.kind === "method" && MUTATION_METHOD_PATTERN.test(name)) {
        surface.push({
          key: `class:${className}.${name}#method`,
          kind: "singleton-mutation-method",
          name: `${className}.${name}`,
          line: lineAt(source, member.start),
          declaration: source.slice(member.start, member.end).slice(0, MAX_DECL_CHARS),
        });
      }
    }
  }
  return surface;
}

export function buildMutableSurfaceExpansionEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): MutableSurfaceExpansionEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  if (changes.length === 0) return undefined;

  const expansions: MutableExpansion[] = [];
  const touchedFiles = new Set<string>();
  let compared = 0;

  const ordered = [...changes].sort((left, right) => {
    if (left.filePath === candidate.filePath) return -1;
    if (right.filePath === candidate.filePath) return 1;
    return left.filePath.localeCompare(right.filePath);
  });

  for (const change of ordered) {
    if (expansions.length >= MAX_EXPANSIONS) break;
    if (change.oldSource === null) {
      const parsed = parseSync(change.filePath, change.source, { range: true });
      if (parsed.errors.some((error) => error.severity === "Error")) continue;
      compared += 1;
      const changed = changedLineSet(change);
      for (const entry of mutableSurface(parsed.program, change.source)) {
        if (expansions.length >= MAX_EXPANSIONS) break;
        if (!changed.has(entry.line)) continue;
        expansions.push({
          filePath: change.filePath,
          kind: entry.kind,
          name: entry.name,
          line: entry.line,
          declaration: entry.declaration,
        });
        touchedFiles.add(change.filePath);
      }
      continue;
    }
    const beforeParsed = parseSync(change.filePath, change.oldSource, { range: true });
    const afterParsed = parseSync(change.filePath, change.source, { range: true });
    if (
      beforeParsed.errors.some((error) => error.severity === "Error")
      || afterParsed.errors.some((error) => error.severity === "Error")
    ) continue;
    compared += 1;
    const changed = changedLineSet(change);
    const beforeKeys = new Set(
      mutableSurface(beforeParsed.program, change.oldSource).map(({ key }) => key),
    );
    for (const entry of mutableSurface(afterParsed.program, change.source)) {
      if (expansions.length >= MAX_EXPANSIONS) break;
      if (beforeKeys.has(entry.key)) continue;
      if (!changed.has(entry.line)) continue;
      expansions.push({
        filePath: change.filePath,
        kind: entry.kind,
        name: entry.name,
        line: entry.line,
        declaration: entry.declaration,
      });
      touchedFiles.add(change.filePath);
    }
  }

  if (expansions.length === 0) return undefined;

  const importers: TouchedModuleImporters[] = [...touchedFiles].map((filePath) => {
    const all = findModuleImporters(filePath, projectFiles);
    return {
      filePath,
      importerCount: all.length,
      importerFiles: all.slice(0, MAX_IMPORTER_FILES).map(({ filePath: importer }) => importer),
    };
  });

  return {
    anchorFile: candidate.filePath,
    coverage: { totalFiles: changes.length, comparedFiles: compared },
    expansions,
    importers,
  };
}
