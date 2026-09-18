import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression, Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionCaller, RelatedProjectModule } from "./repository.js";

const NULLABLE_METHODS = new Set([
  "find",
  "findFirst",
  "findUnique",
  "findOne",
  "get",
  "querySelector",
  "match",
]);

export type NullableDereference = {
  source: string;
  binding: string | null;
  origin: string | null;
  guarded: boolean;
};

export type UnguardedNullableDereferenceEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  dereferences: NullableDereference[];
  validatorImports: string[];
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function finalCalleeName(callee: CallExpression["callee"]): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression") {
    if (callee.property.type === "Identifier") return callee.property.name;
    if (callee.property.type === "Literal") return String(callee.property.value);
  }
  return null;
}

function guardedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(
    /if\s*\(\s*!\s*([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*)\s*(?:===?|!==?)\s*(?:null|undefined)|(?:null|undefined)\s*(?:===?|!==?)\s*([A-Za-z_$][\w$]*)/g,
  )) {
    const name = match[1] ?? match[2] ?? match[3];
    if (name) names.add(name);
  }
  return names;
}

export function buildUnguardedNullableDereferenceEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnguardedNullableDereferenceEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const functionSource = ownerFile.source.slice(fn.start, fn.end);
  const guarded = guardedNames(functionSource);
  const origins = new Map<string, string>();
  const chainedRanges: Node[] = [];

  new Visitor({
    ChainExpression(node) {
      if (containsNode(fn, node)) chainedRanges.push(node);
    },
    VariableDeclarator(node) {
      if (!containsNode(fn, node) || node.id.type !== "Identifier" || !node.init) return;
      if (node.init.type === "CallExpression") {
        const name = finalCalleeName(node.init.callee);
        if (name && NULLABLE_METHODS.has(name)) {
          origins.set(node.id.name, nodeSource(node.init, ownerFile.source));
        }
      }
      if (
        node.init.type === "MemberExpression"
        && node.init.object.type === "Identifier"
        && /^(?:params|query|searchParams|headers|body)$/i.test(node.init.object.name)
      ) {
        origins.set(node.id.name, nodeSource(node.init, ownerFile.source));
      }
    },
    AssignmentExpression(node) {
      if (node.left.type !== "Identifier" || node.right.type !== "CallExpression") return;
      if (!containsNode(fn, node)) return;
      const name = finalCalleeName(node.right.callee);
      if (name && NULLABLE_METHODS.has(name)) {
        origins.set(node.left.name, nodeSource(node.right, ownerFile.source));
      }
    },
  }).visit(parsed.program);

  const dereferences: NullableDereference[] = [];
  const isChained = (node: Node): boolean =>
    chainedRanges.some((range) => containsNode(range, node));

  new Visitor({
    MemberExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (node.object.type !== "Identifier") {
        if (
          node.object.type === "CallExpression"
          && NULLABLE_METHODS.has(finalCalleeName(node.object.callee) ?? "")
        ) {
          dereferences.push({
            source: nodeSource(node, ownerFile.source),
            binding: null,
            origin: nodeSource(node.object, ownerFile.source),
            guarded: isChained(node),
          });
        }
        return;
      }
      const origin = origins.get(node.object.name);
      if (!origin) return;
      dereferences.push({
        source: nodeSource(node, ownerFile.source),
        binding: node.object.name,
        origin,
        guarded: isChained(node) || guarded.has(node.object.name),
      });
    },
    CallExpression(call) {
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested)) return;
      if (
        call.callee.type !== "MemberExpression"
        || call.callee.object.type !== "Identifier"
      ) return;
      const origin = origins.get(call.callee.object.name);
      if (!origin) return;
      dereferences.push({
        source: nodeSource(call, ownerFile.source),
        binding: call.callee.object.name,
        origin,
        guarded: isChained(call) || guarded.has(call.callee.object.name),
      });
    },
    LogicalExpression(node) {
      if (node.operator !== "??" || !containsNode(fn, node)) return;
      const text = nodeSource(node, ownerFile.source);
      for (const dereference of dereferences) {
        if (!dereference.guarded && text.includes(dereference.source)) {
          dereference.guarded = true;
        }
      }
    },
  }).visit(parsed.program);

  const unguarded = dereferences.filter((dereference) => !dereference.guarded);
  if (unguarded.length === 0) return undefined;

  const validatorImports = moduleImports(parsed.program)
    .filter(({ source }) => /zod|io-ts|yup|ajv|assert|validator/i.test(source))
    .map(({ source }) => source);
  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    dereferences,
    validatorImports,
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(candidate.filePath, parsed.program, projectFiles),
    },
  };
}
