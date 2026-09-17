import { parseSync, Visitor } from "oxc-parser";
import type { BindingPattern, Expression, ParamPattern } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

type InteractionKind =
  | "io"
  | "environment"
  | "process"
  | "time"
  | "randomness"
  | "browser"
  | "global-state";

type Interaction = {
  expression: string;
  kind: InteractionKind;
};

type CalculationKind = "arithmetic" | "comparison" | "branch" | "loop";

type Calculation = {
  expression: string;
  kind: CalculationKind;
};

export type MixedCalculationAndInteractionEvidence = {
  function: {
    name: string;
    async: boolean;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  interactions: Interaction[];
  calculations: Calculation[];
  dataflow: {
    interactionResultNames: string[];
    calculationUsesInteractionResult: boolean;
    interactionUsesCalculatedValue: boolean;
  };
  callers: FunctionCaller[];
};

type SourceRange = {
  start: number;
  end: number;
};

const IO_MODULES = new Set([
  "node:child_process",
  "node:dgram",
  "node:dns",
  "node:fs",
  "node:fs/promises",
  "node:http",
  "node:https",
  "node:net",
  "node:tls",
  "@aws-sdk/client-dynamodb",
  "@aws-sdk/client-s3",
  "@google-cloud/storage",
  "axios",
  "better-sqlite3",
  "got",
  "ioredis",
  "mongodb",
  "mysql2",
  "pg",
  "redis",
  "undici",
]);

function memberPath(expression: Expression): string[] | undefined {
  if (expression.type === "Identifier") return [expression.name];
  if (expression.type === "ChainExpression") return memberPath(expression.expression);
  if (expression.type === "MetaProperty") {
    return [`${expression.meta.name}.${expression.property.name}`];
  }
  if (
    expression.type === "TSAsExpression"
    || expression.type === "TSNonNullExpression"
    || expression.type === "TSSatisfiesExpression"
    || expression.type === "TSTypeAssertion"
    || expression.type === "ParenthesizedExpression"
  ) return memberPath(expression.expression);
  if (expression.type !== "MemberExpression") return undefined;
  const object = memberPath(expression.object);
  if (!object) return undefined;
  if (!expression.computed && expression.property.type === "Identifier") {
    return [...object, expression.property.name];
  }
  return object;
}

function ambientKind(path: string[]): Exclude<InteractionKind, "io"> | undefined {
  const [root, second, third] = path;
  if (root === "process" && second === "env") return "environment";
  if (root === "Deno" && second === "env") return "environment";
  if (root === "import.meta" && second === "env") return "environment";
  if (root === "process" && ["argv", "cwd", "pid", "platform"].includes(second ?? "")) return "process";
  if (root === "Date" || (root === "performance" && second === "now")) return "time";
  if (
    (root === "Math" && second === "random")
    || (root === "crypto" && ["getRandomValues", "randomUUID"].includes(second ?? ""))
  ) return "randomness";
  if (["document", "location", "navigator", "window"].includes(root ?? "")) return "browser";
  if (["localStorage", "sessionStorage"].includes(root ?? "") && second !== undefined) return "browser";
  if (root === "globalThis" && second !== undefined && third !== "undefined") return "global-state";
  return undefined;
}

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    return expression.object.type === "Super" ? undefined : rootIdentifier(expression.object);
  }
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  if (
    expression.type === "TSAsExpression"
    || expression.type === "TSNonNullExpression"
    || expression.type === "TSSatisfiesExpression"
    || expression.type === "TSTypeAssertion"
    || expression.type === "ParenthesizedExpression"
  ) return rootIdentifier(expression.expression);
  return undefined;
}

const ARITHMETIC = new Set(["+", "-", "*", "/", "%", "**"]);
const COMPARISON = new Set(["<", ">", "<=", ">=", "==", "===", "!=", "!=="]);

function declaratorNames(id: BindingPattern | ParamPattern): string[] {
  if (id.type === "Identifier") return [id.name];
  if (id.type === "AssignmentPattern") return declaratorNames(id.left);
  if (id.type === "RestElement") return declaratorNames(id.argument);
  if (id.type === "TSParameterProperty") return declaratorNames(id.parameter);
  if (id.type === "ObjectPattern") {
    return id.properties.flatMap((property) =>
      property.type === "RestElement" ? declaratorNames(property.argument) : declaratorNames(property.value)
    );
  }
  if (id.type === "ArrayPattern") {
    return id.elements.flatMap((element) => element ? declaratorNames(element) : []);
  }
  return [];
}

export function buildMixedCalculationAndInteractionEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): MixedCalculationAndInteractionEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const imports = moduleImports(parsed.program);
  const inScope = (node: SourceRange): boolean =>
    node.start >= candidate.start && node.end <= candidate.end;

  type Located<T> = T & SourceRange;
  const interactions: Array<Located<Interaction>> = [];
  const calculations: Array<Located<Calculation>> = [];
  const typeRanges: SourceRange[] = [];

  new Visitor({
    TSTypeAnnotation(node) {
      typeRanges.push(node);
    },
    TSTypeQuery(node) {
      typeRanges.push(node);
    },
    CallExpression(node) {
      if (!inScope(node)) return;
      const root = rootIdentifier(node.callee);
      const imported = root ? imports.find(({ local }) => local === root) : undefined;
      if (imported && IO_MODULES.has(imported.source)) {
        interactions.push({
          expression: owner.source.slice(node.start, node.end).replaceAll(/\s+/g, " ").slice(0, 200),
          kind: "io",
          start: node.start,
          end: node.end,
        });
      } else if (root === "fetch" && !imported) {
        interactions.push({
          expression: owner.source.slice(node.start, node.end).replaceAll(/\s+/g, " ").slice(0, 200),
          kind: "io",
          start: node.start,
          end: node.end,
        });
      } else {
        const path = memberPath(node.callee);
        const kind = path ? ambientKind(path) : undefined;
        if (kind) {
          interactions.push({
            expression: owner.source.slice(node.start, node.end).replaceAll(/\s+/g, " ").slice(0, 200),
            kind,
            start: node.start,
            end: node.end,
          });
        }
      }
    },
    MemberExpression(node) {
      if (!inScope(node)) return;
      const path = memberPath(node);
      const kind = path ? ambientKind(path) : undefined;
      if (kind) {
        interactions.push({
          expression: owner.source.slice(node.start, node.end).replaceAll(/\s+/g, " ").slice(0, 200),
          kind,
          start: node.start,
          end: node.end,
        });
      }
    },
    NewExpression(node) {
      if (!inScope(node)) return;
      if (
        node.arguments.length === 0
        && node.callee.type === "Identifier"
        && node.callee.name === "Date"
      ) {
        interactions.push({
          expression: owner.source.slice(node.start, node.end).replaceAll(/\s+/g, " ").slice(0, 200),
          kind: "time",
          start: node.start,
          end: node.end,
        });
      }
    },
    BinaryExpression(node) {
      if (!inScope(node)) return;
      const kind: CalculationKind | undefined = ARITHMETIC.has(node.operator)
        ? "arithmetic"
        : COMPARISON.has(node.operator)
          ? "comparison"
          : undefined;
      if (!kind) return;
      calculations.push({
        expression: owner.source.slice(node.start, node.end).replaceAll(/\s+/g, " ").slice(0, 200),
        kind,
        start: node.start,
        end: node.end,
      });
    },
    IfStatement(node) {
      if (!inScope(node)) return;
      calculations.push({
        expression: owner.source.slice(node.start, Math.min(node.end, node.start + 200)).replaceAll(/\s+/g, " ").slice(0, 200),
        kind: "branch",
        start: node.start,
        end: node.end,
      });
    },
    ConditionalExpression(node) {
      if (!inScope(node)) return;
      calculations.push({
        expression: owner.source.slice(node.start, node.end).replaceAll(/\s+/g, " ").slice(0, 200),
        kind: "branch",
        start: node.start,
        end: node.end,
      });
    },
    SwitchStatement(node) {
      if (!inScope(node)) return;
      calculations.push({
        expression: owner.source.slice(node.start, Math.min(node.end, node.start + 200)).replaceAll(/\s+/g, " ").slice(0, 200),
        kind: "branch",
        start: node.start,
        end: node.end,
      });
    },
    ForStatement(node) {
      if (!inScope(node)) return;
      calculations.push({
        expression: owner.source.slice(node.start, Math.min(node.end, node.start + 200)).replaceAll(/\s+/g, " ").slice(0, 200),
        kind: "loop",
        start: node.start,
        end: node.end,
      });
    },
    ForInStatement(node) {
      if (!inScope(node)) return;
      calculations.push({
        expression: owner.source.slice(node.start, Math.min(node.end, node.start + 200)).replaceAll(/\s+/g, " ").slice(0, 200),
        kind: "loop",
        start: node.start,
        end: node.end,
      });
    },
    ForOfStatement(node) {
      if (!inScope(node)) return;
      calculations.push({
        expression: owner.source.slice(node.start, Math.min(node.end, node.start + 200)).replaceAll(/\s+/g, " ").slice(0, 200),
        kind: "loop",
        start: node.start,
        end: node.end,
      });
    },
    WhileStatement(node) {
      if (!inScope(node)) return;
      calculations.push({
        expression: owner.source.slice(node.start, Math.min(node.end, node.start + 200)).replaceAll(/\s+/g, " ").slice(0, 200),
        kind: "loop",
        start: node.start,
        end: node.end,
      });
    },
    DoWhileStatement(node) {
      if (!inScope(node)) return;
      calculations.push({
        expression: owner.source.slice(node.start, Math.min(node.end, node.start + 200)).replaceAll(/\s+/g, " ").slice(0, 200),
        kind: "loop",
        start: node.start,
        end: node.end,
      });
    },
  }).visit(parsed.program);

  const outermostInteractions = interactions.filter((item) => !interactions.some((other) =>
    item !== other && other.start <= item.start && other.end >= item.end
  ));
  const outermostCalculations = calculations.filter((item) => !calculations.some((other) =>
    item !== other && other.start <= item.start && other.end >= item.end
  ));

  if (outermostInteractions.length === 0 || outermostCalculations.length === 0) return undefined;

  const interactionRanges: SourceRange[] = outermostInteractions;
  const calcRanges: SourceRange[] = outermostCalculations;
  const contains = (ranges: SourceRange[], start: number, end: number): boolean =>
    ranges.some((range) => range.start <= start && range.end >= end);

  const interactionResultNames = new Set<string>();
  const calculatedNames = new Set<string>();
  const encloses = (outer: SourceRange, inner: SourceRange): boolean =>
    outer.start <= inner.start && outer.end >= inner.end;
  new Visitor({
    VariableDeclarator(node) {
      if (!inScope(node)) return;
      if (!node.init) return;
      const names = declaratorNames(node.id);
      const initRange = { start: node.init.start, end: node.init.end };
      if (interactionRanges.some((range) => encloses(initRange, range))) {
        for (const binding of names) interactionResultNames.add(binding);
      } else if (calcRanges.some((range) => encloses(initRange, range))) {
        for (const binding of names) calculatedNames.add(binding);
      }
    },
  }).visit(parsed.program);

  const calcMentioned = new Set<string>();
  const interactionMentioned = new Set<string>();
  new Visitor({
    Identifier(node) {
      if (!inScope(node)) return;
      if (contains(typeRanges, node.start, node.end)) return;
      if (contains(calcRanges, node.start, node.end)) calcMentioned.add(node.name);
      if (contains(interactionRanges, node.start, node.end)) interactionMentioned.add(node.name);
    },
  }).visit(parsed.program);

  const calculationUsesInteractionResult = [...interactionResultNames].some((binding) =>
    calcMentioned.has(binding)
  );
  const interactionUsesCalculatedValue = [...calculatedNames].some((binding) =>
    interactionMentioned.has(binding)
  );

  return {
    function: {
      name,
      async: fn.async,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    interactions: outermostInteractions,
    calculations: outermostCalculations,
    dataflow: {
      interactionResultNames: [...interactionResultNames].slice(0, 10),
      calculationUsesInteractionResult,
      interactionUsesCalculatedValue,
    },
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
