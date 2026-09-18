import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type {
  CallExpression,
  DoWhileStatement,
  Expression,
  ForInStatement,
  ForOfStatement,
  ForStatement,
  Node,
  WhileStatement,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, containsNode, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller, RelatedProjectModule } from "./repository.js";

type Loop = ForStatement | ForOfStatement | ForInStatement | WhileStatement | DoWhileStatement;

export type LoopPersistenceCall = {
  loopSource: string;
  collection: string | null;
  collectionProvenance: "parameter" | "request" | "unknown";
  call: string;
  calleeRoot: string;
  importedFrom: string | null;
  ownership: "project-module" | "external-package";
  persistenceSignals: string[];
  batchEntryPoint: string | null;
};

export type CallInLoopPersistenceEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  loops: LoopPersistenceCall[];
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

const PERSISTENCE_SOURCE = /repo|orm|prisma|drizzle|typeorm|mongoose|sequelize|query|database|\bdb\b|sql|storage|\bdao\b|model|collection|table|entity|persist/i;
const PERSISTENCE_SYMBOL = /save|insert|update|delete|remove|upsert|persist|create|write|query|find|get|load|fetch|push|publish|repo|model|entity/i;
const BATCH_ENTRY = /saveAll|saveMany|insertMany|bulk[A-Z]\w*|batch[A-Z]\w*|upsertMany|writeMany|updateMany|deleteMany/i;

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    return expression.object.type === "Super" ? undefined : rootIdentifier(expression.object);
  }
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  return undefined;
}

function unwrapAwaited(argument: Expression): CallExpression | undefined {
  if (argument.type === "CallExpression") return argument;
  if (argument.type === "ChainExpression" && argument.expression.type === "CallExpression") {
    return argument.expression;
  }
  return undefined;
}

function parameterNames(fn: NonNullable<ReturnType<typeof findDirectFunction>>, source: string): Set<string> {
  const names = new Set<string>();
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(value.start, value.end));
    if (match?.[0]) names.add(match[0]);
  }
  return names;
}

function loopCollection(loop: Loop, source: string): string | null {
  if (loop.type === "ForOfStatement" || loop.type === "ForInStatement") {
    return nodeSource(loop.right, source);
  }
  return null;
}

export function buildCallInLoopPersistenceEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): CallInLoopPersistenceEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const nested = nestedFunctionRanges(parsed.program, fn);
  const imports = moduleImports(parsed.program);
  const parameters = parameterNames(fn, ownerFile.source);

  const loops: Loop[] = [];
  const addLoop = (loop: Loop): void => {
    if (containsNode(fn, loop) && belongsDirectlyToFunction(loop, nested)) loops.push(loop);
  };
  new Visitor({
    DoWhileStatement: addLoop,
    ForInStatement: addLoop,
    ForOfStatement: addLoop,
    ForStatement: addLoop,
    WhileStatement: addLoop,
  }).visit(parsed.program);

  const results: LoopPersistenceCall[] = [];
  for (const loop of loops) {
    const awaited: CallExpression[] = [];
    new Visitor({
      AwaitExpression(node) {
        if (!containsNode(loop, node) || !belongsDirectlyToFunction(node, nested)) return;
        const call = unwrapAwaited(node.argument);
        if (call) awaited.push(call);
      },
    }).visit(parsed.program);
    for (const call of awaited) {
      const root = rootIdentifier(call.callee);
      if (!root) continue;
      const imported = imports.find(({ local }) => local === root);
      if (!imported) continue;
      const target = resolveModule(ownerFile.filePath, imported.source, projectFiles);
      const ownership = imported.source.startsWith(".")
        ? target ? ("project-module" as const) : undefined
        : ("external-package" as const);
      if (!ownership) continue;
      const signals: string[] = [];
      if (PERSISTENCE_SOURCE.test(imported.source)) signals.push(`import source ${imported.source}`);
      if (PERSISTENCE_SYMBOL.test(imported.imported)) signals.push(`imported symbol ${imported.imported}`);
      if (PERSISTENCE_SYMBOL.test(root) && imported.source.startsWith(".")) {
        signals.push(`callee name ${root}`);
      }
      if (target && PERSISTENCE_SOURCE.test(target.source.slice(0, 4000))) {
        signals.push(`target module ${target.filePath}`);
      }
      if (signals.length === 0) continue;
      let batchEntryPoint: string | null = null;
      if (target) {
        const match = BATCH_ENTRY.exec(target.source);
        if (match?.[0]) batchEntryPoint = match[0];
      }
      const collection = loopCollection(loop, ownerFile.source);
      const collectionRoot = collection ? /^[A-Za-z_$][\w$]*/.exec(collection.trim())?.[0] : undefined;
      const collectionProvenance = collectionRoot && parameters.has(collectionRoot)
        ? ("parameter" as const)
        : collection && /req|request|body|params|query/i.test(collection)
          ? ("request" as const)
          : ("unknown" as const);
      results.push({
        loopSource: nodeSource(loop, ownerFile.source),
        collection,
        collectionProvenance,
        call: nodeSource(call, ownerFile.source),
        calleeRoot: root,
        importedFrom: imported.source,
        ownership,
        persistenceSignals: signals,
        batchEntryPoint,
      });
    }
  }
  if (results.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: ownerFile.source.slice(0, 16_000),
    },
    loops: results,
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(candidate.filePath, parsed.program, projectFiles),
    },
  };
}
