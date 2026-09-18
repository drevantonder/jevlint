import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type BindingSide = {
  kind: "param" | "local" | "catch-param" | "import" | "module-binding" | "outer-binding";
  typeText: string | null;
  line: number;
};

export type ShadowingPair = {
  name: string;
  inner: BindingSide;
  outer: BindingSide;
};

export type ShadowedMeaningEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  pairs: ShadowingPair[];
  callers: FunctionCaller[];
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function paramName(parameter: FunctionNode["params"][number]): string | undefined {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  if (value.type === "Identifier") return value.name;
  if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
    return value.left.name;
  }
  if (value.type === "RestElement" && value.argument.type === "Identifier") {
    return value.argument.name;
  }
  return undefined;
}

export function buildShadowedMeaningEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ShadowedMeaningEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const outer = new Map<string, BindingSide>();
  for (const imported of moduleImports(parsed.program)) {
    if (!outer.has(imported.local)) {
      const statement = parsed.program.body.find((node) =>
        node.type === "ImportDeclaration"
        && node.specifiers.some((specifier) => specifier.local.name === imported.local)
      );
      outer.set(imported.local, {
        kind: "import",
        typeText: statement ? owner.source.slice(statement.start, statement.end).slice(0, 200) : null,
        line: statement ? lineAt(owner.source, statement.start) : 0,
      });
    }
  }

  for (const statement of parsed.program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (!declaration) continue;
    if (
      (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration")
      && declaration.id
    ) {
      if (!outer.has(declaration.id.name)) {
        outer.set(declaration.id.name, {
          kind: "module-binding",
          typeText: owner.source.slice(declaration.start, Math.min(declaration.start + 200, declaration.end)),
          line: lineAt(owner.source, declaration.start),
        });
      }
    }
    if (declaration.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (item.id.type !== "Identifier" || outer.has(item.id.name)) continue;
        outer.set(item.id.name, {
          kind: "module-binding",
          typeText: owner.source.slice(item.start, item.end).slice(0, 200),
          line: lineAt(owner.source, item.start),
        });
      }
    }
  }

  const containers: FunctionNode[] = [];
  new Visitor({
    ArrowFunctionExpression(node) {
      if (node.start <= candidate.start && node.end >= candidate.end && node !== fn) {
        containers.push(node);
      }
    },
    FunctionDeclaration(node) {
      if (node.start <= candidate.start && node.end >= candidate.end && node !== fn) {
        containers.push(node);
      }
    },
    FunctionExpression(node) {
      if (node.start <= candidate.start && node.end >= candidate.end && node !== fn) {
        containers.push(node);
      }
    },
  }).visit(parsed.program);

  for (const container of containers) {
    for (const parameter of container.params) {
      const binding = paramName(parameter);
      if (!binding || outer.has(binding)) continue;
      outer.set(binding, {
        kind: "outer-binding",
        typeText: owner.source.slice(parameter.start, parameter.end).slice(0, 200),
        line: lineAt(owner.source, parameter.start),
      });
    }
  }

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const direct = (node: { start: number; end: number }): boolean =>
    node.start >= candidate.start
    && node.end <= candidate.end
    && !nested.some((range) => range.start <= node.start && range.end >= node.end);

  const pairs: ShadowingPair[] = [];
  const seen = new Set<string>();

  const consider = (binding: string, inner: BindingSide): void => {
    const outerSide = outer.get(binding);
    if (!outerSide) return;
    const key = `${binding}:${inner.kind}:${inner.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ name: binding, inner, outer: outerSide });
  };

  for (const parameter of fn.params) {
    const binding = paramName(parameter);
    if (!binding) continue;
    consider(binding, {
      kind: "param",
      typeText: owner.source.slice(parameter.start, parameter.end).slice(0, 200),
      line: lineAt(owner.source, parameter.start),
    });
  }

  new Visitor({
    VariableDeclarator(node) {
      if (!direct(node) || node.id.type !== "Identifier") return;
      consider(node.id.name, {
        kind: "local",
        typeText: owner.source.slice(node.start, node.end).slice(0, 200),
        line: lineAt(owner.source, node.start),
      });
    },
    CatchClause(node) {
      if (!direct(node)) return;
      const param = node.param;
      if (param?.type === "Identifier") {
        consider(param.name, {
          kind: "catch-param",
          typeText: owner.source.slice(param.start, param.end).slice(0, 200),
          line: lineAt(owner.source, param.start),
        });
      }
    },
  }).visit(parsed.program);

  if (pairs.length === 0) return undefined;
  pairs.sort((left, right) => left.inner.line - right.inner.line);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    pairs: pairs.slice(0, 10),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
