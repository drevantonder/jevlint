import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller, ModuleImport } from "./repository.js";

const PERSISTENCE_MODULE = /(?:^|\/)(?:persistence|repositories?|database|db|prisma|drizzle|entities|models?|schema|generated)(?:\/|[.-]|$)|^(?:@prisma\/client|typeorm|sequelize|drizzle-orm|mongoose|@mikro-orm\/|knex|kysely)(?:\/|$)/;

export type PersistenceModelLeakEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  persistence: {
    imports: ModuleImport[];
    returnType: string | null;
    returnedExpressions: string[];
    operations: string[];
    relatedModules: Array<{ filePath: string; source: string }>;
  };
  callers: FunctionCaller[];
  consumers: Array<{ filePath: string; source: string }>;
};

function mentionsIdentifier(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(source);
}

function uniqueConsumerModules(
  callers: FunctionCaller[],
  projectFiles: ProjectFile[],
): Array<{ filePath: string; source: string }> {
  const paths = new Set(callers.map(({ filePath }) => filePath));
  return projectFiles
    .filter(({ filePath }) => paths.has(filePath))
    .slice(0, 20)
    .map(({ filePath, source }) => ({ filePath, source: source.slice(0, 12_000) }));
}

export function buildPersistenceModelLeakEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): PersistenceModelLeakEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find(({ filePath }) => filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some(({ severity }) => severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const persistenceImports = moduleImports(parsed.program).filter((item) =>
    PERSISTENCE_MODULE.test(item.source) && mentionsIdentifier(candidate.source, item.local),
  );
  if (persistenceImports.length === 0) return undefined;
  const persistenceBindings = new Set(persistenceImports.map(({ local }) => local));
  const returnedExpressions: string[] = [];
  const operations = new Set<string>();
  new Visitor({
    CallExpression(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      const callee = owner.source.slice(node.callee.start, node.callee.end);
      if ([...persistenceBindings].some((binding) => mentionsIdentifier(callee, binding))) {
        operations.add(callee);
      }
    },
    ReturnStatement(node) {
      if (node.start < candidate.start || node.end > candidate.end || !node.argument) return;
      returnedExpressions.push(owner.source.slice(node.argument.start, node.argument.end));
    },
  }).visit(parsed.program);
  if (fn.body && fn.body.type !== "BlockStatement") {
    returnedExpressions.push(owner.source.slice(fn.body.start, fn.body.end));
  }

  const returnType = fn.returnType
    ? owner.source.slice(fn.returnType.start, fn.returnType.end)
    : null;
  const persistenceReturnType = returnType !== null
    && [...persistenceBindings].some((binding) => mentionsIdentifier(returnType, binding));
  if (operations.size === 0 && !persistenceReturnType) return undefined;

  const relatedModules = persistenceImports.flatMap((item) => {
    const resolved = resolveModule(owner.filePath, item.source, projectFiles);
    return resolved
      ? [{ filePath: resolved.filePath, source: resolved.source.slice(0, 12_000) }]
      : [];
  }).filter((module, index, modules) =>
    modules.findIndex(({ filePath }) => filePath === module.filePath) === index,
  ).slice(0, 12);
  const callers = findFunctionCallers(owner.filePath, name, projectFiles);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    persistence: {
      imports: persistenceImports,
      returnType,
      returnedExpressions,
      operations: [...operations],
      relatedModules,
    },
    callers,
    consumers: uniqueConsumerModules(callers, projectFiles),
  };
}
