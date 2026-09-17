import { parseSync, Visitor } from "oxc-parser";
import type {
  ArrowFunctionExpression,
  Function as OxcFunction,
  Program,
  TSInterfaceDeclaration,
  TSPropertySignature,
  TSTypeAliasDeclaration,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { moduleImports, resolveModule } from "./repository.js";

export type StateModelDeclaration = TSInterfaceDeclaration | TSTypeAliasDeclaration;

export type StateModelUsage = {
  filePath: string;
  kind: "function" | "variable" | "assertion";
  source: string;
  propertiesReferenced: string[];
  truncated: boolean;
};

export type StateModelUsageResult = {
  usages: StateModelUsage[];
  total: number;
  files: number;
};

type UsageRange = StateModelUsage & {
  start: number;
  end: number;
};

type FunctionNode = OxcFunction | ArrowFunctionExpression;

export function findStateModelDeclaration(
  program: Program,
  candidate: Candidate,
): StateModelDeclaration | undefined {
  let result: StateModelDeclaration | undefined;
  const match = (node: StateModelDeclaration): void => {
    if (node.start === candidate.start && node.end === candidate.end) result = node;
  };
  new Visitor({
    TSInterfaceDeclaration: match,
    TSTypeAliasDeclaration: match,
  }).visit(program);
  return result;
}

export function stateModelProperties(
  declaration: StateModelDeclaration,
): TSPropertySignature[] {
  const members = declaration.type === "TSInterfaceDeclaration"
    ? declaration.body.body
    : declaration.typeAnnotation.type === "TSTypeLiteral"
      ? declaration.typeAnnotation.members
      : [];
  return members.filter((member): member is TSPropertySignature =>
    member.type === "TSPropertySignature"
  );
}

export function statePropertyName(property: TSPropertySignature): string | undefined {
  if (property.computed || property.key.type !== "Identifier") return undefined;
  return property.key.name;
}

function aliasesForStateModel(
  program: Program,
  filePath: string,
  ownerPath: string,
  typeName: string,
  projectFiles: ProjectFile[],
): Set<string> {
  const aliases = new Set<string>();
  if (filePath === ownerPath) aliases.add(typeName);
  for (const imported of moduleImports(program)) {
    if (imported.imported !== typeName) continue;
    if (resolveModule(filePath, imported.source, projectFiles)?.filePath === ownerPath) {
      aliases.add(imported.local);
    }
  }
  return aliases;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsAlias(source: string, aliases: Set<string>): boolean {
  return [...aliases].some((alias) => new RegExp(`\\b${escapeRegExp(alias)}\\b`).test(source));
}

function propertiesReferenced(source: string, propertyNames: string[]): string[] {
  return propertyNames.filter((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`).test(source));
}

function functionUsesAlias(node: FunctionNode, source: string, aliases: Set<string>): boolean {
  const annotations = node.params.map((parameter) => source.slice(parameter.start, parameter.end));
  if (node.returnType) annotations.push(source.slice(node.returnType.start, node.returnType.end));
  return annotations.some((annotation) => mentionsAlias(annotation, aliases));
}

function boundedUsage(
  filePath: string,
  kind: StateModelUsage["kind"],
  source: string,
  start: number,
  end: number,
  propertyNames: string[],
): UsageRange {
  const completeSource = source.slice(start, end);
  return {
    filePath,
    kind,
    source: completeSource.slice(0, 6_000),
    propertiesReferenced: propertiesReferenced(completeSource, propertyNames),
    truncated: completeSource.length > 6_000,
    start,
    end,
  };
}

function removeContainedUsages(usages: UsageRange[]): UsageRange[] {
  const result: UsageRange[] = [];
  const sorted = [...usages].sort((left, right) =>
    left.filePath.localeCompare(right.filePath)
    || left.start - right.start
    || right.end - left.end,
  );
  for (const usage of sorted) {
    const container = result.find((existing) =>
      existing.filePath === usage.filePath
      && existing.start <= usage.start
      && existing.end >= usage.end,
    );
    if (!container) result.push(usage);
  }
  return result;
}

export function findStateModelUsages(
  ownerPath: string,
  typeName: string,
  propertyNames: string[],
  projectFiles: ProjectFile[],
): StateModelUsageResult {
  const found: UsageRange[] = [];
  for (const file of projectFiles) {
    const parsed = parseSync(file.filePath, file.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const aliases = aliasesForStateModel(
      parsed.program,
      file.filePath,
      ownerPath,
      typeName,
      projectFiles,
    );
    if (aliases.size === 0) continue;

    const addFunction = (node: FunctionNode): void => {
      if (!functionUsesAlias(node, file.source, aliases)) return;
      found.push(boundedUsage(
        file.filePath,
        "function",
        file.source,
        node.start,
        node.end,
        propertyNames,
      ));
    };
    new Visitor({
      ArrowFunctionExpression: addFunction,
      FunctionDeclaration: addFunction,
      FunctionExpression: addFunction,
      VariableDeclarator(node) {
        const declaration = file.source.slice(node.id.start, node.id.end);
        if (!mentionsAlias(declaration, aliases)) return;
        found.push(boundedUsage(
          file.filePath,
          "variable",
          file.source,
          node.start,
          node.end,
          propertyNames,
        ));
      },
      TSAsExpression(node) {
        const annotation = file.source.slice(node.typeAnnotation.start, node.typeAnnotation.end);
        if (!mentionsAlias(annotation, aliases)) return;
        found.push(boundedUsage(
          file.filePath,
          "assertion",
          file.source,
          node.start,
          node.end,
          propertyNames,
        ));
      },
      TSSatisfiesExpression(node) {
        const annotation = file.source.slice(node.typeAnnotation.start, node.typeAnnotation.end);
        if (!mentionsAlias(annotation, aliases)) return;
        found.push(boundedUsage(
          file.filePath,
          "assertion",
          file.source,
          node.start,
          node.end,
          propertyNames,
        ));
      },
      TSTypeAssertion(node) {
        const annotation = file.source.slice(node.typeAnnotation.start, node.typeAnnotation.end);
        if (!mentionsAlias(annotation, aliases)) return;
        found.push(boundedUsage(
          file.filePath,
          "assertion",
          file.source,
          node.start,
          node.end,
          propertyNames,
        ));
      },
    }).visit(parsed.program);
  }

  const distinct = removeContainedUsages(found);
  const included = distinct.slice(0, 20).map(({ start: _start, end: _end, ...usage }) => usage);
  return {
    usages: included,
    total: distinct.length,
    files: new Set(distinct.map(({ filePath }) => filePath)).size,
  };
}
