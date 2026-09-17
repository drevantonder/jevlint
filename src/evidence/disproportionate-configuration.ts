import { parseSync, Visitor } from "oxc-parser";
import type { Program, TSInterfaceDeclaration, TSTypeAliasDeclaration } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findFunctionCallers,
  functionName,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

type ConfiguredFunctionEvidence = {
  filePath: string;
  name: string;
  source: string;
  callers: FunctionCaller[];
};

export type DisproportionateConfigurationEvidence = {
  configuration: {
    name: string;
    filePath: string;
    source: string;
    memberCount: number;
  };
  configuredFunctions: ConfiguredFunctionEvidence[];
};

type ConfigurationDeclaration = TSInterfaceDeclaration | TSTypeAliasDeclaration;

function findConfigurationDeclaration(
  program: Program,
  candidate: Candidate,
): ConfigurationDeclaration | undefined {
  let result: ConfigurationDeclaration | undefined;
  const matches = (node: ConfigurationDeclaration): void => {
    if (node.start === candidate.start && node.end === candidate.end) result = node;
  };
  new Visitor({
    TSInterfaceDeclaration: matches,
    TSTypeAliasDeclaration: matches,
  }).visit(program);
  return result;
}

function memberCount(declaration: ConfigurationDeclaration): number | undefined {
  if (declaration.type === "TSInterfaceDeclaration") return declaration.body.body.length;
  if (declaration.typeAnnotation.type === "TSTypeLiteral") {
    return declaration.typeAnnotation.members.length;
  }
  return undefined;
}

function aliasesFor(
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

function usesAlias(parameterSource: string, aliases: Set<string>): boolean {
  return [...aliases].some((alias) => new RegExp(`\\b${alias}\\b`).test(parameterSource));
}

function configuredFunctions(
  ownerPath: string,
  typeName: string,
  projectFiles: ProjectFile[],
): ConfiguredFunctionEvidence[] {
  const result: ConfiguredFunctionEvidence[] = [];
  for (const file of projectFiles) {
    const parsed = parseSync(file.filePath, file.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const aliases = aliasesFor(
      parsed.program,
      file.filePath,
      ownerPath,
      typeName,
      projectFiles,
    );
    if (aliases.size === 0) continue;
    const addConfiguredFunction = (node: FunctionNode): void => {
      const name = functionName(parsed.program, node);
      if (!name) return;
      const usesConfiguration = node.params.some((parameter) =>
        usesAlias(file.source.slice(parameter.start, parameter.end), aliases),
      );
      if (!usesConfiguration) return;
      result.push({
        filePath: file.filePath,
        name,
        source: file.source.slice(node.start, node.end),
        callers: findFunctionCallers(file.filePath, name, projectFiles),
      });
    };
    new Visitor({
      ArrowFunctionExpression: addConfiguredFunction,
      FunctionDeclaration: addConfiguredFunction,
      FunctionExpression: addConfiguredFunction,
    }).visit(parsed.program);
  }
  return result.slice(0, 20);
}

export function buildDisproportionateConfigurationEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DisproportionateConfigurationEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const declaration = findConfigurationDeclaration(parsed.program, candidate);
  if (!declaration) return undefined;
  const members = memberCount(declaration);
  if (members === undefined) return undefined;
  const name = declaration.id.name;
  const functions = configuredFunctions(owner.filePath, name, projectFiles);
  if (functions.length === 0) return undefined;

  return {
    configuration: {
      name,
      filePath: owner.filePath,
      source: candidate.source,
      memberCount: members,
    },
    configuredFunctions: functions,
  };
}
