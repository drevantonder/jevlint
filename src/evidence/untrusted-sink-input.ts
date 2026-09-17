import { parseSync, Visitor } from "oxc-parser";
import type { CallExpression, Expression } from "oxc-parser";
import type { Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  isInsideNestedFunction,
  moduleImports,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

const SINK_METHODS = new Set([
  "query",
  "execute",
  "exec",
  "execSync",
  "execFile",
  "execFileSync",
  "spawn",
  "spawnSync",
  "write",
  "writeln",
  "insertAdjacentHTML",
]);

export type SinkSource = {
  expression: string;
  kind: "parameter" | "request" | "ambient" | "constant" | "local" | "unknown";
};

export type SinkCall = {
  call: string;
  sink: string;
  receiver: string | null;
  argument: string;
  sources: SinkSource[];
  hasPlaceholders: boolean;
  shellEnabled: boolean;
};

export type UntrustedSinkInputEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  sinks: SinkCall[];
  escapeHelpers: string[];
  modelingImports: string[];
  callers: FunctionCaller[];
};

function rootIdentifier(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") return rootIdentifier(expression.object);
  if (expression.type === "ChainExpression") return rootIdentifier(expression.expression);
  return undefined;
}

function unwrap(expression: Expression): Expression {
  return expression.type === "ChainExpression" ? expression.expression : expression;
}

function sinkName(call: CallExpression): { sink: string; receiver: string | null } | undefined {
  const callee = unwrap(call.callee);
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
    if (!SINK_METHODS.has(callee.property.name)) return undefined;
    return { sink: callee.property.name, receiver: rootIdentifier(callee.object) ?? null };
  }
  if (callee.type === "Identifier" && SINK_METHODS.has(callee.name)) {
    return { sink: callee.name, receiver: null };
  }
  return undefined;
}

function isConstantLiteral(expression: Expression): boolean {
  const node = unwrap(expression);
  if (node.type === "Literal") return true;
  if (node.type === "TemplateLiteral") return node.expressions.length === 0;
  return node.type === "UnaryExpression" && node.argument.type === "Literal";
}

function interpolationExpressions(argument: Expression): Expression[] | undefined {
  const node = unwrap(argument);
  if (node.type === "TemplateLiteral" && node.expressions.length > 0) return [...node.expressions];
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const collect = (expression: Expression): Expression[] => {
      const current = unwrap(expression);
      if (current.type === "BinaryExpression" && current.operator === "+") {
        return [...collect(current.left), ...collect(current.right)];
      }
      return [current];
    };
    const parts = [node.left, node.right].flatMap(collect);
    return parts.some((part) => !isConstantLiteral(part)) ? parts.filter((part) => !isConstantLiteral(part)) : undefined;
  }
  return undefined;
}

const REQUEST_ROOTS = new Set(["req", "request", "res", "response", "ctx", "context", "headers", "query", "body", "params", "input", "args"]);
const AMBIENT_ROOTS = new Set(["process", "env", "localStorage", "sessionStorage", "window", "document", "location", "navigator"]);

export function buildUntrustedSinkInputEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UntrustedSinkInputEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nestedFunctions = nestedFunctionRanges(parsed.program, candidate);
  const inScope = (node: Node): boolean =>
    node.start >= candidate.start
    && node.end <= candidate.end
    && !isInsideNestedFunction(node, nestedFunctions);

  const parameters = new Set<string>();
  for (const parameter of fn.params) {
    const match = /^(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(
      owner.source.slice(parameter.start, parameter.end).trim(),
    );
    if (match?.[1]) parameters.add(match[1]);
  }

  const moduleConstants = new Set<string>();
  const localBindings = new Set<string>();
  new Visitor({
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier") return;
      if (
        node.start >= candidate.start
        && node.end <= candidate.end
        && isInsideNestedFunction(node, nestedFunctions)
      ) return;
      if (node.init && isConstantLiteral(node.init)) {
        if (node.start < candidate.start || node.end > candidate.end) {
          moduleConstants.add(node.id.name);
        } else {
          localBindings.add(node.id.name);
        }
      } else if (node.start >= candidate.start && node.end <= candidate.end) {
        localBindings.add(node.id.name);
      }
    },
  }).visit(parsed.program);

  const classify = (expression: Expression): SinkSource => {
    const text = owner.source.slice(expression.start, expression.end).slice(0, 200);
    const node = unwrap(expression);
    if (node.type === "Identifier") {
      if (parameters.has(node.name)) return { expression: text, kind: "parameter" };
      if (moduleConstants.has(node.name)) return { expression: text, kind: "constant" };
      if (localBindings.has(node.name)) return { expression: text, kind: "local" };
      return { expression: text, kind: "unknown" };
    }
    const root = rootIdentifier(node);
    if (root) {
      if (parameters.has(root)) {
        return {
          expression: text,
          kind: REQUEST_ROOTS.has(root) || root === "req" || root === "request" ? "request" : "parameter",
        };
      }
      if (REQUEST_ROOTS.has(root)) return { expression: text, kind: "request" };
      if (AMBIENT_ROOTS.has(root)) return { expression: text, kind: "ambient" };
      if (moduleConstants.has(root)) return { expression: text, kind: "constant" };
      if (localBindings.has(root)) return { expression: text, kind: "local" };
    }
    if (isConstantLiteral(node)) return { expression: text, kind: "constant" };
    return { expression: text, kind: "unknown" };
  };

  const sinks: SinkCall[] = [];
  const innerHTMLWrites: { start: number; end: number }[] = [];
  new Visitor({
    CallExpression(node) {
      if (!inScope(node)) return;
      const sink = sinkName(node);
      if (!sink) return;
      for (const argument of node.arguments) {
        if (argument.type === "SpreadElement") continue;
        const interpolations = interpolationExpressions(argument);
        if (!interpolations) continue;
        const argumentText = owner.source.slice(argument.start, argument.end);
        sinks.push({
          call: owner.source.slice(node.start, node.end).slice(0, 500),
          sink: sink.sink,
          receiver: sink.receiver,
          argument: argumentText.slice(0, 500),
          sources: interpolations.map(classify).slice(0, 8),
          hasPlaceholders: /\$\d|\?/.test(argumentText),
          shellEnabled: /shell\s*:\s*true/.test(owner.source.slice(node.start, node.end)),
        });
      }
    },
    AssignmentExpression(node) {
      if (!inScope(node)) return;
      if (node.left.type !== "MemberExpression") return;
      const left = unwrap(node.left);
      if (
        left.type !== "MemberExpression"
        || left.property.type !== "Identifier"
        || left.property.name !== "innerHTML"
      ) return;
      innerHTMLWrites.push({ start: node.start, end: node.end });
      const interpolations = interpolationExpressions(node.right);
      if (!interpolations) return;
      const argumentText = owner.source.slice(node.right.start, node.right.end);
      sinks.push({
        call: owner.source.slice(node.start, node.end).slice(0, 500),
        sink: "innerHTML",
        receiver: rootIdentifier(left.object) ?? null,
        argument: argumentText.slice(0, 500),
        sources: interpolations.map(classify).slice(0, 8),
        hasPlaceholders: false,
        shellEnabled: false,
      });
    },
  }).visit(parsed.program);

  if (sinks.length === 0 && innerHTMLWrites.length === 0) return undefined;
  if (sinks.length === 0) return undefined;
  const everySourceTame = sinks.every(({ sources }) =>
    sources.length > 0
    && sources.every(({ kind }) => kind === "constant" || kind === "local")
  );
  if (everySourceTame) return undefined;

  const imports = moduleImports(parsed.program);
  const escapeHelpers = imports
    .filter(({ local, imported }) => /escape|sanitize|parameteri|quote/i.test(local) || /escape|sanitize/i.test(imported))
    .map(({ local }) => local);
  const modelingImports = imports
    .filter(({ source }) => /knex|prisma|drizzle|typeorm|sequelize|zod|validator|escape|sanitize/i.test(source))
    .map(({ source }) => source);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    sinks,
    escapeHelpers,
    modelingImports,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
