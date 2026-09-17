import { parseSync, Visitor } from "oxc-parser";
import type { Expression, Node, PrivateIdentifier } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, containsNode } from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  findDirectFunction,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionNode } from "./repository.js";

export type DistrustfulGuard = {
  source: string;
  guarded: string;
  declaredType: string;
  kind: "typeof-check" | "null-check" | "instanceof-check";
};

export type DistrustfulTypeGuardEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  params: {
    name: string;
    declaredType: string;
    nullable: boolean;
    untyped: boolean;
  }[];
  guards: DistrustfulGuard[];
};

const BOUNDARY_PATTERN =
  /JSON\.parse|fetch\s*\(|axios|process\.env|req\.|request\.|ctx\.|event\.|FormData|URLSearchParams|as\s+any|as\s+unknown|@ts-ignore|@ts-expect-error/;

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function annotatedParams(fn: FunctionNode, source: string): { name: string; declaredType: string }[] {
  const result: { name: string; declaredType: string }[] = [];
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    if (value.type !== "Identifier") continue;
    const text = source.slice(parameter.start, parameter.end).trim();
    const colon = text.indexOf(":");
    if (colon < 0) continue;
    if (text.slice(0, colon).replace(/\?$/, "").trim() !== value.name) continue;
    const declaredType = text.slice(colon + 1).trim();
    if (declaredType) result.push({ name: value.name, declaredType });
  }
  return result;
}

function isNullable(declaredType: string): boolean {
  return /\bnull\b|\bundefined\b|\bvoid\b|\?/.test(declaredType);
}

function isUntyped(declaredType: string): boolean {
  return /\bany\b|\bunknown\b/.test(declaredType);
}

function isSingleType(declaredType: string): boolean {
  if (isNullable(declaredType)) return false;
  const scrubbed = declaredType.replace(/\s+/g, "").replace(/^\(|\)$/g, "");
  return /^[A-Za-z_$][\w$]*$/.test(scrubbed);
}

function identifierName(expression: Expression | PrivateIdentifier): string | undefined {
  if (expression.type === "PrivateIdentifier") return undefined;
  const value = expression.type === "TSAsExpression" || expression.type === "TSSatisfiesExpression"
    ? expression.expression
    : expression;
  return value.type === "Identifier" ? value.name : undefined;
}

function collectTests(test: Expression, into: Expression[]): void {
  if (test.type === "LogicalExpression" && (test.operator === "&&" || test.operator === "||")) {
    collectTests(test.left, into);
    collectTests(test.right, into);
    return;
  }
  into.push(test);
}

export function buildDistrustfulTypeGuardEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DistrustfulTypeGuardEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  if (BOUNDARY_PATTERN.test(candidate.source)) return undefined;
  const parsed = parseSync(ownerFile.filePath, ownerFile.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn: FunctionNode | undefined = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const annotated = annotatedParams(fn, ownerFile.source).filter(
    ({ declaredType }) => !isUntyped(declaredType),
  );
  if (annotated.length === 0) return undefined;
  const byName = new Map(annotated.map(({ name, declaredType }) => [name, declaredType]));

  const nested: NodeRange[] = [];
  new Visitor({
    ArrowFunctionExpression(node) {
      if (node !== fn && containsNode(fn, node)) nested.push(node);
    },
    FunctionDeclaration(node) {
      if (node !== fn && containsNode(fn, node)) nested.push(node);
    },
    FunctionExpression(node) {
      if (node !== fn && containsNode(fn, node)) nested.push(node);
    },
  }).visit(parsed.program);

  const guards: DistrustfulGuard[] = [];
  const inspectTests = (tests: Expression[]): void => {
    for (const test of tests) {
      if (test.type === "UnaryExpression" && test.operator === "typeof") {
        const guarded = identifierName(test.argument);
        const declaredType = guarded ? byName.get(guarded) : undefined;
        if (guarded && declaredType && !isNullable(declaredType)) {
          guards.push({
            source: nodeSource(test, ownerFile.source).slice(0, 200),
            guarded,
            declaredType,
            kind: "typeof-check",
          });
        }
        continue;
      }
      if (test.type === "BinaryExpression") {
        const left = test.left;
        const right = test.right;
        const isTypeofSide = (
          side: Expression | PrivateIdentifier,
        ): { guarded: string; literal: string } | undefined => {
          if (side.type === "PrivateIdentifier") return undefined;
          if (side.type === "UnaryExpression" && side.operator === "typeof") {
            const guarded = identifierName(side.argument);
            return guarded ? { guarded, literal: "" } : undefined;
          }
          return undefined;
        };
        const leftTypeof = isTypeofSide(left);
        const rightTypeof = isTypeofSide(right);
        const typeofInfo = leftTypeof ?? rightTypeof;
        const otherSide = leftTypeof ? right : rightTypeof ? left : undefined;
        if (
          typeofInfo
          && otherSide?.type === "Literal"
          && (test.operator === "===" || test.operator === "!==" || test.operator === "==" || test.operator === "!=")
        ) {
          const declaredType = byName.get(typeofInfo.guarded);
          if (declaredType && isSingleType(declaredType)) {
            guards.push({
              source: nodeSource(test, ownerFile.source).slice(0, 200),
              guarded: typeofInfo.guarded,
              declaredType,
              kind: "typeof-check",
            });
          }
          continue;
        }
        const nullLiteral = (side: Expression | PrivateIdentifier): boolean =>
          side.type === "PrivateIdentifier"
            ? false
            : (side.type === "Literal" && side.value === null)
              || (side.type === "Identifier" && side.name === "undefined");
        if (
          (test.operator === "==" || test.operator === "!=" || test.operator === "===" || test.operator === "!==")
          && (nullLiteral(left) || nullLiteral(right))
        ) {
          const guarded = identifierName(nullLiteral(left) ? right : left);
          const declaredType = guarded ? byName.get(guarded) : undefined;
          if (guarded && declaredType && !isNullable(declaredType)) {
            guards.push({
              source: nodeSource(test, ownerFile.source).slice(0, 200),
              guarded,
              declaredType,
              kind: "null-check",
            });
          }
          continue;
        }
        if (test.operator === "instanceof") {
          const guarded = identifierName(test.left);
          const className = test.right.type === "Identifier" ? test.right.name : undefined;
          const declaredType = guarded ? byName.get(guarded) : undefined;
          if (guarded && className && declaredType && declaredType.replace(/\s+/g, "") === className) {
            guards.push({
              source: nodeSource(test, ownerFile.source).slice(0, 200),
              guarded,
              declaredType,
              kind: "instanceof-check",
            });
          }
        }
      }
    }
  };

  new Visitor({
    IfStatement(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const tests: Expression[] = [];
      collectTests(node.test, tests);
      inspectTests(tests);
    },
    ConditionalExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const tests: Expression[] = [];
      collectTests(node.test, tests);
      inspectTests(tests);
    },
  }).visit(parsed.program);

  if (guards.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    params: annotated.map(({ name: paramName, declaredType }) => ({
      name: paramName,
      declaredType,
      nullable: isNullable(declaredType),
      untyped: isUntyped(declaredType),
    })),
    guards: guards.slice(0, 10),
  };
}
