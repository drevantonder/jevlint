import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type {
  BlockStatement,
  CallExpression,
  Class,
  Expression,
  MethodDefinition,
  Node,
  Program,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findModuleImporters,
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type { FunctionNode, ModuleImporter } from "./repository.js";

export type LayerMember = {
  name: string;
  exported: boolean;
  forwardsTo: string | null;
  statementCount: number;
  hasBranching: boolean;
};

export type ShallowConvenienceLayerEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  layer: {
    kind: "class" | "module";
    name: string;
    members: LayerMember[];
  };
  collaborator: {
    root: string;
    importedFrom: string | null;
    ownership: "same-module" | "project-module" | "external-package" | "unresolved";
    directImporters: ModuleImporter[];
  };
  repository: {
    layerImporters: ModuleImporter[];
  };
};

function contains(outer: Node, inner: Node): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

function calleeRootName(callee: CallExpression["callee"]): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression") {
    if (callee.object.type === "Super") return null;
    return memberObjectRoot(callee.object);
  }
  if (callee.type === "ChainExpression") {
    const chained = callee.expression;
    if (chained.type === "CallExpression") return calleeRootName(chained.callee);
    if (chained.type === "MemberExpression") {
      if (chained.object.type === "Super") return null;
      return memberObjectRoot(chained.object);
    }
  }
  return null;
}

function memberObjectRoot(object: Expression): string | null {
  if (object.type === "Identifier") return object.name;
  if (object.type === "MemberExpression") {
    if (object.object.type === "Super") return null;
    return memberObjectRoot(object.object);
  }
  if (object.type === "CallExpression") return calleeRootName(object.callee);
  return null;
}

function delegatedRoot(body: BlockStatement): { root: string | null } | undefined {
  if (body.body.length !== 1) return undefined;
  const only = body.body[0];
  if (!only || only.type !== "ReturnStatement" || !only.argument) return undefined;
  const returned = only.argument.type === "AwaitExpression" ? only.argument.argument : only.argument;
  if (returned.type !== "CallExpression") return undefined;
  return { root: calleeRootName(returned.callee) };
}

function analyzeCallable(
  program: Program,
  source: string,
  fn: FunctionNode,
): Omit<LayerMember, "name" | "exported"> {
  const body = fn.body;
  if (!body) return { forwardsTo: null, statementCount: 0, hasBranching: false };
  const nested = nestedFunctionRanges(program, fn);
  let hasBranching = false;
  const direct = (node: Node): boolean => contains(fn, node) && belongsDirectlyToFunction(node, nested);
  new Visitor({
    IfStatement: (node) => {
      if (direct(node)) hasBranching = true;
    },
    ConditionalExpression: (node) => {
      if (direct(node)) hasBranching = true;
    },
    SwitchStatement: (node) => {
      if (direct(node)) hasBranching = true;
    },
    TryStatement: (node) => {
      if (direct(node)) hasBranching = true;
    },
    ThrowStatement: (node) => {
      if (direct(node)) hasBranching = true;
    },
    ForStatement: (node) => {
      if (direct(node)) hasBranching = true;
    },
    ForInStatement: (node) => {
      if (direct(node)) hasBranching = true;
    },
    ForOfStatement: (node) => {
      if (direct(node)) hasBranching = true;
    },
    WhileStatement: (node) => {
      if (direct(node)) hasBranching = true;
    },
    DoWhileStatement: (node) => {
      if (direct(node)) hasBranching = true;
    },
  }).visit(program);
  if (hasBranching) {
    return {
      forwardsTo: null,
      statementCount: body.type === "BlockStatement" ? body.body.length : 1,
      hasBranching,
    };
  }
  if (body.type === "BlockStatement") {
    if (body.body.length !== 1) {
      return { forwardsTo: null, statementCount: body.body.length, hasBranching };
    }
    const target = delegatedRoot(body);
    return { forwardsTo: target?.root ?? null, statementCount: 1, hasBranching };
  }
  const unwrapped = body.type === "AwaitExpression" ? body.argument : body;
  if (unwrapped.type === "CallExpression") {
    return { forwardsTo: calleeRootName(unwrapped.callee), statementCount: 1, hasBranching };
  }
  return { forwardsTo: null, statementCount: 1, hasBranching };
}

function methodKeyName(source: string, definition: MethodDefinition): string {
  if (definition.key.type === "Identifier") return definition.key.name;
  return source.slice(definition.key.start, definition.key.end);
}

export function buildShallowConvenienceLayerEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ShallowConvenienceLayerEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn: FunctionNode | undefined = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const members: LayerMember[] = [];
  let anchorMember: string | undefined;
  let layerKind: "class" | "module" = "module";
  let layerName = owner.filePath;

  // A layer of methods forwarding to one collaborator is the canonical
  // shallow-convenience form, so the enclosing class wins over the module.
  const classes: Class[] = [];
  new Visitor({
    ClassDeclaration: (node) => {
      if (node.start <= candidate.start && candidate.end <= node.end) classes.push(node);
    },
    ClassExpression: (node) => {
      if (node.start <= candidate.start && candidate.end <= node.end) classes.push(node);
    },
  }).visit(parsed.program);
  const enclosing = classes.sort((left, right) =>
    (right.end - right.start) - (left.end - left.start)
  ).pop();

  if (enclosing) {
    layerKind = "class";
    layerName = enclosing.id?.name ?? "(anonymous class)";
    const classExported = enclosing.type === "ClassDeclaration";
    for (const definition of enclosing.body.body) {
      if (definition.type !== "MethodDefinition") continue;
      if (definition.value.type !== "FunctionExpression") continue;
      const methodName = methodKeyName(owner.source, definition);
      const analysis = analyzeCallable(parsed.program, owner.source, definition.value);
      members.push({
        name: methodName,
        exported: classExported && definition.kind !== "constructor",
        ...analysis,
      });
      if (definition.value.start === candidate.start && definition.value.end === candidate.end) {
        anchorMember = methodName;
      }
    }
  } else {
    for (const statement of parsed.program.body) {
      const declaration = statement.type === "ExportNamedDeclaration"
        ? statement.declaration
        : statement;
      if (declaration?.type === "FunctionDeclaration" && declaration.id?.name) {
        if (declaration.body === undefined) continue;
        const analysis = analyzeCallable(parsed.program, owner.source, declaration);
        members.push({
          name: declaration.id.name,
          exported: isFunctionExported(parsed.program, declaration, declaration.id.name),
          ...analysis,
        });
        if (declaration.start === candidate.start && declaration.end === candidate.end) {
          anchorMember = declaration.id.name;
        }
      }
      if (declaration?.type === "VariableDeclaration") {
        for (const item of declaration.declarations) {
          if (item.id.type !== "Identifier") continue;
          if (item.init?.type !== "ArrowFunctionExpression" && item.init?.type !== "FunctionExpression") {
            continue;
          }
          const analysis = analyzeCallable(parsed.program, owner.source, item.init);
          members.push({
            name: item.id.name,
            exported: statement.type === "ExportNamedDeclaration",
            ...analysis,
          });
          if (item.init.start === candidate.start && item.init.end === candidate.end) {
            anchorMember = item.id.name;
          }
        }
      }
    }
  }

  const name = anchorMember ?? functionName(parsed.program, fn);
  if (!name) return undefined;

  const tallies = new Map<string, number>();
  for (const member of members) {
    if (member.forwardsTo) tallies.set(member.forwardsTo, (tallies.get(member.forwardsTo) ?? 0) + 1);
  }
  let collaboratorRoot: string | undefined;
  let collaboratorCount = 0;
  for (const [root, count] of tallies) {
    if (count > collaboratorCount) {
      collaboratorRoot = root;
      collaboratorCount = count;
    }
  }
  // One forwarder is a per-function question, not a layer question; the
  // layer proposition needs a mirrored method set.
  if (!collaboratorRoot || collaboratorCount < 2) return undefined;

  const imports = moduleImports(parsed.program);
  const imported = imports.find(({ local }) => local === collaboratorRoot);
  const targetFile = imported
    ? resolveModule(owner.filePath, imported.source, projectFiles)
    : undefined;
  const ownership = imported
    ? imported.source.startsWith(".") ? "project-module" : "external-package"
    : targetFile ? "same-module" : "unresolved";

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    layer: {
      kind: layerKind,
      name: layerName,
      members: members.slice(0, 20),
    },
    collaborator: {
      root: collaboratorRoot,
      importedFrom: imported?.source ?? null,
      ownership,
      directImporters: targetFile && targetFile.filePath !== owner.filePath
        ? findModuleImporters(targetFile.filePath, projectFiles).filter(
          (importer) => importer.filePath !== owner.filePath,
        )
        : [],
    },
    repository: {
      layerImporters: findModuleImporters(owner.filePath, projectFiles),
    },
  };
}
