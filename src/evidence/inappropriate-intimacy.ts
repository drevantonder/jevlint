import { parseSync, Visitor } from "oxc-parser";
import type {
  Expression,
  MemberExpression,
  Program,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";

export type ForeignAccess = {
  root: string;
  chain: string;
  depth: number;
  privateMarked: boolean;
  asserted: boolean;
  beyondAdvertised: boolean;
  line: number;
};

export type ImportedInterfaceEvidence = {
  local: string;
  imported: string;
  source: string;
  ownership: "project-module" | "external-package";
  bypassesBarrel: boolean;
  exportedMembers: string[] | null;
  reExportAll: boolean;
};

export type FellowImporterEvidence = {
  source: string;
  total: number;
  included: number;
  importers: string[];
};

export type InappropriateIntimacyEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  imports: ImportedInterfaceEvidence[];
  foreignAccesses: ForeignAccess[];
  fellowImporters: FellowImporterEvidence[];
};

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") return rootIdentifier(expression.object);
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  return undefined;
}

function chainDepth(expression: Expression): number {
  if (expression.type === "MemberExpression") return 1 + chainDepth(expression.object);
  if (expression.type === "ChainExpression") return chainDepth(expression.expression);
  return 0;
}

function memberNames(expression: Expression): string[] {
  if (expression.type === "MemberExpression") {
    const property = expression.property.type === "Identifier" && !expression.computed
      ? [expression.property.name]
      : expression.property.type === "PrivateIdentifier"
        ? [`#${expression.property.name}`]
        : [];
    return [...memberNames(expression.object), ...property];
  }
  if (expression.type === "ChainExpression") return memberNames(expression.expression);
  return [];
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function collectBinding(statement: Program["body"][number], members: Set<string>): void {
  const declaration = statement.type === "ExportNamedDeclaration"
    ? statement.declaration
    : statement.type === "ExportDefaultDeclaration"
      ? statement.declaration
      : statement;
  if (!declaration) return;
  if (
    declaration.type === "FunctionDeclaration"
    || declaration.type === "ClassDeclaration"
    || declaration.type === "TSInterfaceDeclaration"
    || declaration.type === "TSTypeAliasDeclaration"
    || declaration.type === "TSEnumDeclaration"
  ) {
    if (declaration.id?.name) members.add(declaration.id.name);
    return;
  }
  if (declaration.type === "VariableDeclaration") {
    for (const item of declaration.declarations) {
      if (item.id.type === "Identifier") members.add(item.id.name);
    }
  }
}

function exportedNames(program: Program) {
  const members = new Set<string>();
  let reExportAll = false;
  for (const statement of program.body) {
    if (statement.type === "ExportAllDeclaration") {
      reExportAll = true;
      continue;
    }
    collectBinding(statement, members);
    if (statement.type === "ExportNamedDeclaration") {
      for (const specifier of statement.specifiers) {
        if (specifier.exported.type === "Identifier") members.add(specifier.exported.name);
      }
    }
  }
  return { members: [...members].sort(), reExportAll };
}

function exportedObjectMembers(program: Program, members: Set<string>): void {
  new Visitor({
    ExportNamedDeclaration(statement) {
      const declaration = statement.declaration;
      if (declaration?.type === "VariableDeclaration") {
        for (const item of declaration.declarations) {
          if (item.init?.type !== "ObjectExpression" || item.id.type !== "Identifier") continue;
          for (const property of item.init.properties) {
            if (property.type !== "Property" || property.computed) continue;
            if (property.key.type === "Identifier") members.add(property.key.name);
          }
        }
        return;
      }
      if (declaration?.type === "ClassDeclaration") {
        for (const element of declaration.body.body) {
          if (element.type !== "MethodDefinition" && element.type !== "PropertyDefinition") continue;
          if (element.key.type === "Identifier") members.add(element.key.name);
        }
      }
    },
  }).visit(program);
}

function bypassesBarrel(source: string): boolean {
  if (!source.startsWith(".")) return source.split("/").includes("internal");
  const segments = source.split("/");
  const parentHops = segments.filter((segment) => segment === "..").length;
  return parentHops >= 2 || segments.includes("internal");
}

function fellowImporters(
  source: string,
  ownerPath: string,
  projectFiles: ProjectFile[],
): FellowImporterEvidence {
  const importers: string[] = [];
  for (const file of projectFiles) {
    if (file.filePath === ownerPath) continue;
    const parsed = parseSync(file.filePath, file.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    if (moduleImports(parsed.program).some((imported) => imported.source === source)) {
      importers.push(file.filePath);
    }
  }
  importers.sort();
  return {
    source,
    total: importers.length,
    included: Math.min(importers.length, 5),
    importers: importers.slice(0, 5),
  };
}

export function buildInappropriateIntimacyEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): InappropriateIntimacyEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const imports = moduleImports(parsed.program);
  if (imports.length === 0) return undefined;
  const importedLocals = new Set(imports.map(({ local }) => local));

  const chains = new Map<number, MemberExpression>();
  new Visitor({
    MemberExpression(node) {
      const existing = chains.get(node.start);
      if (!existing || node.end > existing.end) chains.set(node.start, node);
    },
  }).visit(parsed.program);

  const advertisedBySource = new Map<string, Set<string>>();
  const importEvidence: ImportedInterfaceEvidence[] = [];
  const seenSources = new Set<string>();
  for (const imported of imports) {
    const ownership = imported.source.startsWith(".") ? "project-module" : "external-package";
    let advertised = advertisedBySource.get(imported.source);
    if (advertised === undefined) {
      const resolved = resolveModule(owner.filePath, imported.source, projectFiles);
      if (resolved && ownership === "project-module") {
        const target = parseSync(resolved.filePath, resolved.source, { range: true });
        if (!target.errors.some((error) => error.severity === "Error")) {
          const { members, reExportAll } = exportedNames(target.program);
          advertised = new Set(members);
          exportedObjectMembers(target.program, advertised);
          if (!seenSources.has(imported.source)) {
            importEvidence.push({
              local: imported.local,
              imported: imported.imported,
              source: imported.source,
              ownership,
              bypassesBarrel: bypassesBarrel(imported.source),
              exportedMembers: members.slice(0, 40),
              reExportAll,
            });
          }
        } else {
          advertised = new Set();
        }
      } else {
        advertised = new Set();
        if (!seenSources.has(imported.source) && ownership === "external-package") {
          importEvidence.push({
            local: imported.local,
            imported: imported.imported,
            source: imported.source,
            ownership,
            bypassesBarrel: bypassesBarrel(imported.source),
            exportedMembers: null,
            reExportAll: false,
          });
        }
      }
      advertisedBySource.set(imported.source, advertised);
    }
    if (!seenSources.has(imported.source) && ownership === "project-module") {
      const already = importEvidence.some((entry) => entry.source === imported.source);
      if (!already) {
        importEvidence.push({
          local: imported.local,
          imported: imported.imported,
          source: imported.source,
          ownership,
          bypassesBarrel: bypassesBarrel(imported.source),
          exportedMembers: [...(advertised ?? [])].slice(0, 40),
          reExportAll: false,
        });
      }
    }
    seenSources.add(imported.source);
  }

  const foreignAccesses: ForeignAccess[] = [];
  for (const node of [...chains.values()].sort((left, right) => left.start - right.start)) {
    const root = rootIdentifier(node);
    if (!root || !importedLocals.has(root)) continue;
    if (node.start < candidate.start || node.end > candidate.end) continue;
    const text = owner.source.slice(node.start, node.end);
    const names = memberNames(node);
    const source = imports.find(({ local }) => local === root)?.source;
    const advertised = source ? advertisedBySource.get(source) : undefined;
    foreignAccesses.push({
      root,
      chain: text.slice(0, 300),
      depth: chainDepth(node),
      privateMarked: names.some((member) => member.startsWith("_") || member.startsWith("#")),
      asserted: /!\s*(\.|\(|\[|$)|as\s+(any|unknown)\b/.test(text),
      beyondAdvertised: advertised !== undefined
        && advertised.size > 0
        && names.some((member) => !advertised.has(member)),
      line: lineAt(owner.source, node.start),
    });
    if (foreignAccesses.length >= 20) break;
  }
  if (foreignAccesses.length === 0) return undefined;

  const fellowSources = [...new Set(
    foreignAccesses.flatMap(({ root }) =>
      imports.filter(({ local }) => local === root).map(({ source }) => source)
    ),
  )].filter((source) => source.startsWith(".")).slice(0, 8);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    imports: importEvidence.slice(0, 12),
    foreignAccesses,
    fellowImporters: fellowSources.map((source) => fellowImporters(source, owner.filePath, projectFiles)),
  };
}
