import { parseSync, Visitor } from "oxc-parser";
import type { Class, Function as OxcFunction, Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type SignatureDrift = {
  kind: "override-arity" | "missing-member" | "arity-shortfall" | "nullable-return";
  source: string;
  detail: string;
};

export type ContractSignatureDriftEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  drifts: SignatureDrift[];
  contractModule: { filePath: string; source: string } | null;
  repository: {
    callers: FunctionCaller[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function methodSignature(
  cls: Class,
  source: string,
): Map<string, { params: number; names: string[]; source: string }> {
  const signatures = new Map<string, { params: number; names: string[]; source: string }>();
  for (const element of cls.body.body) {
    if (element.type !== "MethodDefinition" && element.type !== "TSAbstractMethodDefinition") {
      continue;
    }
    if (element.kind === "constructor") continue;
    if (element.key.type !== "Identifier") continue;
    if (
      element.value.type !== "FunctionExpression"
      && element.value.type !== "TSEmptyBodyFunctionExpression"
    ) continue;
    signatures.set(element.key.name, {
      params: element.value.params.length,
      names: element.value.params.map((parameter) => nodeSource(parameter, source).slice(0, 80)),
      source: "",
    });
  }
  return signatures;
}

function requiredParams(fn: FunctionNode | OxcFunction, source: string): number {
  return fn.params.filter((parameter) => {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    if (value.type === "AssignmentPattern" || value.type === "RestElement") return false;
    const text = nodeSource(parameter, source).trim();
    return !/\?\s*:/.test(text) && !text.endsWith("?");
  }).length;
}

function returnAnnotation(fn: FunctionNode, source: string): string | null {
  const paramsEnd = fn.params.length > 0 ? fn.params[fn.params.length - 1]?.end : undefined;
  const bodyStart = fn.body?.start;
  if (paramsEnd === undefined || bodyStart === undefined) return null;
  const between = source.slice(paramsEnd, bodyStart);
  const match = /\)\s*:\s*(.+?)\s*(?:=>)?$/.exec(between.trim());
  return match?.[1]?.trim() ?? null;
}

export function buildContractSignatureDriftEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ContractSignatureDriftEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseSync(ownerFile.filePath, ownerFile.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const drifts: SignatureDrift[] = [];
  let contractModule: { filePath: string; source: string } | null = null;

  const declarations = new Map<string, { required: number; source: string }>();
  new Visitor({
    FunctionDeclaration(node) {
      if (node.id) {
        declarations.set(node.id.name, {
          required: requiredParams(node, ownerFile.source),
          source: nodeSource(node, ownerFile.source).slice(0, 500),
        });
      }
    },
    VariableDeclarator(node) {
      if (
        node.id.type === "Identifier"
        && (node.init?.type === "ArrowFunctionExpression" || node.init?.type === "FunctionExpression")
      ) {
        declarations.set(node.id.name, {
          required: requiredParams(node.init, ownerFile.source),
          source: nodeSource(node, ownerFile.source).slice(0, 500),
        });
      }
    },
  }).visit(parsed.program);

  new Visitor({
    CallExpression(call) {
      if (!containsNode(fn, call) || !belongsDirectlyToFunction(call, nested)) return;
      if (call.callee.type !== "Identifier") return;
      const declaration = declarations.get(call.callee.name);
      if (!declaration) return;
      if (call.arguments.length < declaration.required) {
        drifts.push({
          kind: "arity-shortfall",
          source: nodeSource(call, ownerFile.source),
          detail: `${call.callee.name} called with ${call.arguments.length} argument(s) but declares ${declaration.required} required parameter(s)`,
        });
      }
    },
    ReturnStatement(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (
        !node.argument
        || (node.argument.type !== "Literal" && node.argument.type !== "Identifier")
      ) return;
      const text = nodeSource(node.argument, ownerFile.source);
      if (text !== "null" && text !== "undefined") return;
      const annotation = returnAnnotation(fn, ownerFile.source);
      if (!annotation) return;
      if (/null|undefined|void|any|unknown/.test(annotation)) return;
      drifts.push({
        kind: "nullable-return",
        source: nodeSource(node, ownerFile.source),
        detail: `returns ${text} against declared contract ${annotation}`,
      });
    },
    ClassDeclaration(cls) {
      if (!(cls.start <= fn.start && cls.end >= fn.end)) return;
      if (!cls.superClass || cls.superClass.type !== "Identifier") return;
      const baseName = cls.superClass.name;
      const own = methodSignature(cls, ownerFile.source);
      let base = new Map<string, { params: number; names: string[]; source: string }>();
      for (const statement of parsed.program.body) {
        const declaration = statement.type === "ExportNamedDeclaration"
          ? statement.declaration
          : statement;
        if (declaration?.type === "ClassDeclaration" && declaration.id?.name === baseName) {
          base = methodSignature(declaration, ownerFile.source);
          contractModule = { filePath: ownerFile.filePath, source: ownerFile.source.slice(0, 12_000) };
        }
      }
      if (base.size === 0) {
        const imported = moduleImports(parsed.program).find(({ local }) => local === baseName);
        if (imported) {
          const resolved = resolveModule(ownerFile.filePath, imported.source, projectFiles);
          if (resolved) {
            contractModule = { filePath: resolved.filePath, source: resolved.source.slice(0, 12_000) };
            const baseParsed = parseSync(resolved.filePath, resolved.source, { range: true });
            if (!baseParsed.errors.some((error) => error.severity === "Error")) {
              new Visitor({
                ClassDeclaration(baseCls) {
                  if (baseCls.id?.name === baseName) base = methodSignature(baseCls, resolved.source);
                },
              }).visit(baseParsed.program);
            }
          }
        }
      }
      for (const [name, signature] of own) {
        const baseSignature = base.get(name);
        if (!baseSignature) continue;
        if (signature.params < baseSignature.params) {
          drifts.push({
            kind: "override-arity",
            source: nodeSource(cls, ownerFile.source).slice(0, 800),
            detail: `${name} declares (${signature.names.join(", ")}) but the ${baseName} contract requires (${baseSignature.names.join(", ")})`,
          });
        }
      }
      for (const [name] of base) {
        if (!own.has(name)) {
          drifts.push({
            kind: "missing-member",
            source: nodeSource(cls, ownerFile.source).slice(0, 800),
            detail: `${baseName} contract requires ${name} but the subclass does not implement it`,
          });
        }
      }
    },
  }).visit(parsed.program);

  if (drifts.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    drifts,
    contractModule,
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
    },
  };
}
