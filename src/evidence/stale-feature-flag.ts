import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression, PrivateIdentifier, Statement } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  nestedFunctionRanges,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type FlagArm = "empty" | "constant-return" | "live" | "missing";

export type FlagCheck = {
  expression: string;
  line: number;
  kind: "if" | "conditional";
  consequent: FlagArm;
  alternate: FlagArm;
};

export type StaleFeatureFlagEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  flagChecks: FlagCheck[];
  flagSourceHint: "constant" | "env" | "config" | "unknown";
  flagSourceDetail: string | null;
  callers: FunctionCaller[];
};

const FLAG_OBJECT_PATTERN = /flag|toggle|experiment|feature|config|setting|permission|kill.?switch/i;
const FLAG_CALL_PATTERN = /^(isEnabled|isDisabled|hasFlag|getFlag|useFlag|useFeatureFlag|useExperiment|isFeatureEnabled|flagEnabled|experimentEnabled)$/i;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function rootName(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    return expression.object.type === "Super" ? undefined : rootName(expression.object);
  }
  if (expression.type === "ChainExpression") return rootName(expression.expression);
  if (expression.type === "ParenthesizedExpression") return rootName(expression.expression);
  return undefined;
}

function asExpression(node: Expression | PrivateIdentifier): Expression | undefined {
  return node.type === "PrivateIdentifier" ? undefined : node;
}

function isFlagTest(expression: Expression, source: string): boolean {
  const text = source.slice(expression.start, expression.end);
  if (expression.type === "CallExpression") {
    const callee = expression.callee;
    if (callee.type === "Identifier" && FLAG_CALL_PATTERN.test(callee.name)) return true;
    if (
      callee.type === "MemberExpression"
      && !callee.computed
      && callee.property.type === "Identifier"
      && (FLAG_CALL_PATTERN.test(callee.property.name) || FLAG_OBJECT_PATTERN.test(callee.property.name))
    ) return true;
    if (FLAG_OBJECT_PATTERN.test(text) && /isEnabled|flag|experiment/i.test(text)) return true;
    return false;
  }
  if (expression.type === "MemberExpression") {
    if (/^process\.env\b/.test(text)) return true;
    return FLAG_OBJECT_PATTERN.test(text);
  }
  if (expression.type === "Identifier") return FLAG_OBJECT_PATTERN.test(expression.name);
  if (expression.type === "UnaryExpression" && expression.operator === "!") {
    return isFlagTest(expression.argument, source);
  }
  if (expression.type === "BinaryExpression" || expression.type === "LogicalExpression") {
    const left = asExpression(expression.left);
    const right = asExpression(expression.right);
    return (left ? isFlagTest(left, source) : false) || (right ? isFlagTest(right, source) : false);
  }
  return false;
}

function classifyArm(node: Statement | Expression | null | undefined, source: string): FlagArm {
  if (!node) return "missing";
  if (node.type === "EmptyStatement") return "empty";
  const text = source.slice(node.start, node.end).trim();
  if (node.type === "BlockStatement") {
    if (node.body.length === 0) return "empty";
    if (
      node.body.length === 1
      && node.body[0]?.type === "ReturnStatement"
      && node.body[0].argument
      && (node.body[0].argument.type === "Literal" || node.body[0].argument.type === "TemplateLiteral")
    ) return "constant-return";
    return "live";
  }
  if (text === "{}" || text === ";") return "empty";
  if (
    (node.type === "Literal" || node.type === "TemplateLiteral")
    || /^return\s+['"`][^'"`]*['"`]\s*;?$/.test(text)
  ) return "constant-return";
  return "live";
}

function literalText(node: { type: string; start: number; end: number }, source: string): string | undefined {
  const raw = source.slice(node.start, node.end);
  const quote = raw[0];
  if (quote !== "\"" && quote !== "'") return undefined;
  if (raw.length < 2 || raw[raw.length - 1] !== quote) return undefined;
  return raw.slice(1, -1);
}

function flagRootName(expression: Expression, source: string): string | undefined {
  if (expression.type === "UnaryExpression" && expression.operator === "!") {
    return flagRootName(expression.argument, source);
  }
  if (expression.type === "BinaryExpression" || expression.type === "LogicalExpression") {
    const left = asExpression(expression.left);
    const right = asExpression(expression.right);
    return (left ? flagRootName(left, source) : undefined) ?? (right ? flagRootName(right, source) : undefined);
  }
  if (expression.type === "CallExpression") {
    for (const argument of expression.arguments) {
      if (argument.type === "SpreadElement") continue;
      if (argument.type !== "Literal") continue;
      const text = literalText(argument, source);
      if (text) return text;
    }
    return rootName(expression.callee);
  }
  return rootName(expression);
}

export type FlagSource = {
  hint: "constant" | "env" | "config" | "unknown";
  detail: string | null;
};

function sourceHintFor(
  flagRoot: string | undefined,
  owner: ProjectFile,
  program: ReturnType<typeof parseCached>["program"],
  projectFiles: ProjectFile[],
): FlagSource {
  if (!flagRoot) return { hint: "unknown", detail: null };
  if (/^process$/.test(flagRoot)) return { hint: "env", detail: "reads process.env" };
  const imports = moduleImports(program);
  const imported = imports.find(({ local }) => local === flagRoot);
  if (!imported) {
    const constantPattern = new RegExp(`(?:const|let|var)\\s+${flagRoot}\\s*=\\s*(true|false|["'][^"']*["'])`);
    const match = constantPattern.exec(owner.source);
    if (match) return { hint: "constant", detail: `module binds ${flagRoot} to ${match[1]}` };
    if (new RegExp(`process\\.env\\b`).test(owner.source)) return { hint: "env", detail: "module reads process.env" };
    return { hint: "unknown", detail: null };
  }
  if (/env|config/i.test(imported.source)) return { hint: "config", detail: `imported from ${imported.source}` };
  const target = resolveModule(owner.filePath, imported.source, projectFiles);
  if (!target) return { hint: "unknown", detail: `imported from ${imported.source}` };
  const constantPattern = new RegExp(
    `(?:const|let|var)\\s+${imported.imported}\\s*=\\s*(true|false|"(?:[^"]*)"|'(?:[^']*)'|\\{[^{}]*\\})`,
  );
  const match = constantPattern.exec(target.source);
  if (match) {
    return { hint: "constant", detail: `${imported.imported} fixed as ${match[1]} in ${target.filePath}` };
  }
  return { hint: "config", detail: `imported from ${target.filePath}` };
}

export function buildStaleFeatureFlagEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): StaleFeatureFlagEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const inScope = (start: number, end: number): boolean =>
    start >= candidate.start && end <= candidate.end
    && !nested.some((range) => range.start <= start && range.end >= end);

  const flagChecks: FlagCheck[] = [];

  new Visitor({
    IfStatement(node) {
      if (!inScope(node.start, node.end)) return;
      if (!isFlagTest(node.test, owner.source)) return;
      flagChecks.push({
        expression: owner.source.slice(node.test.start, node.test.end),
        line: lineAt(owner.source, node.test.start),
        kind: "if",
        consequent: classifyArm(node.consequent, owner.source),
        alternate: classifyArm(node.alternate ?? null, owner.source),
      });
    },
    ConditionalExpression(node) {
      if (!inScope(node.start, node.end)) return;
      if (!isFlagTest(node.test, owner.source)) return;
      flagChecks.push({
        expression: owner.source.slice(node.test.start, node.test.end),
        line: lineAt(owner.source, node.test.start),
        kind: "conditional",
        consequent: classifyArm(node.consequent, owner.source),
        alternate: classifyArm(node.alternate, owner.source),
      });
    },
  }).visit(parsed.program);

  if (flagChecks.length === 0) return undefined;

  const roots = new Set<string>();
  new Visitor({
    IfStatement(node) {
      if (!inScope(node.start, node.end)) return;
      if (!isFlagTest(node.test, owner.source)) return;
      const root = flagRootName(node.test, owner.source);
      if (root) roots.add(root);
    },
    ConditionalExpression(node) {
      if (!inScope(node.start, node.end)) return;
      if (!isFlagTest(node.test, owner.source)) return;
      const root = flagRootName(node.test, owner.source);
      if (root) roots.add(root);
    },
  }).visit(parsed.program);

  const [primaryRoot] = [...roots];
  const { hint, detail } = sourceHintFor(primaryRoot, owner, parsed.program, projectFiles);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    flagChecks,
    flagSourceHint: hint,
    flagSourceDetail: detail,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
