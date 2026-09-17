import { parseSync, Visitor } from "oxc-parser";
import type { Class, Program, TSInterfaceDeclaration } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { moduleImports, resolveModule } from "./repository.js";

type ImplementationEvidence = {
  filePath: string;
  name: string;
  source: string;
};

type ConsumerEvidence = {
  filePath: string;
  source: string;
};

export type NeedlessAbstractionEvidence = {
  abstraction: {
    name: string;
    kind: "interface";
    filePath: string;
    source: string;
    moduleSource: string;
  };
  implementations: ImplementationEvidence[];
  consumers: ConsumerEvidence[];
};

function findInterface(
  program: Program,
  candidate: Candidate,
): TSInterfaceDeclaration | undefined {
  let result: TSInterfaceDeclaration | undefined;
  new Visitor({
    TSInterfaceDeclaration(node) {
      if (node.start === candidate.start && node.end === candidate.end) result = node;
    },
  }).visit(program);
  return result;
}

function interfaceAliases(
  program: Program,
  filePath: string,
  ownerPath: string,
  interfaceName: string,
  projectFiles: ProjectFile[],
): Set<string> {
  const aliases = new Set<string>();
  if (filePath === ownerPath) aliases.add(interfaceName);
  for (const imported of moduleImports(program)) {
    if (imported.imported !== interfaceName) continue;
    if (resolveModule(filePath, imported.source, projectFiles)?.filePath === ownerPath) {
      aliases.add(imported.local);
    }
  }
  return aliases;
}

function classImplements(node: Class, aliases: Set<string>): boolean {
  return (node.implements ?? []).some(({ expression }) =>
    expression.type === "Identifier" && aliases.has(expression.name),
  );
}

function implementationName(node: Class): string {
  return node.id?.name ?? "anonymous class";
}

function findImplementations(
  ownerPath: string,
  interfaceName: string,
  projectFiles: ProjectFile[],
): ImplementationEvidence[] {
  const implementations: ImplementationEvidence[] = [];
  for (const file of projectFiles) {
    const parsed = parseSync(file.filePath, file.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const aliases = interfaceAliases(
      parsed.program,
      file.filePath,
      ownerPath,
      interfaceName,
      projectFiles,
    );
    if (aliases.size === 0) continue;
    new Visitor({
      ClassDeclaration(node) {
        if (!classImplements(node, aliases)) return;
        implementations.push({
          filePath: file.filePath,
          name: implementationName(node),
          source: file.source.slice(node.start, node.end),
        });
      },
    }).visit(parsed.program);
  }
  return implementations.slice(0, 20);
}

function findConsumers(
  ownerPath: string,
  interfaceName: string,
  implementations: ImplementationEvidence[],
  projectFiles: ProjectFile[],
): ConsumerEvidence[] {
  const symbols = [
    { filePath: ownerPath, name: interfaceName },
    ...implementations.map(({ filePath, name }) => ({ filePath, name })),
  ];
  const implementationFiles = new Set(implementations.map(({ filePath }) => filePath));
  const consumers: ConsumerEvidence[] = [];
  for (const file of projectFiles) {
    if (file.filePath === ownerPath || implementationFiles.has(file.filePath)) continue;
    const parsed = parseSync(file.filePath, file.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const consumes = moduleImports(parsed.program).some((imported) => {
      const resolved = resolveModule(file.filePath, imported.source, projectFiles);
      return symbols.some((symbol) =>
        symbol.filePath === resolved?.filePath && symbol.name === imported.imported,
      );
    });
    if (consumes) consumers.push({ filePath: file.filePath, source: file.source.slice(0, 12_000) });
  }
  return consumers.slice(0, 20);
}

export function buildNeedlessAbstractionEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): NeedlessAbstractionEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const declaration = findInterface(parsed.program, candidate);
  if (!declaration) return undefined;
  const name = declaration.id.name;
  const implementations = findImplementations(owner.filePath, name, projectFiles);
  if (implementations.length === 0) return undefined;

  return {
    abstraction: {
      name,
      kind: "interface",
      filePath: owner.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    implementations,
    consumers: findConsumers(owner.filePath, name, implementations, projectFiles),
  };
}
