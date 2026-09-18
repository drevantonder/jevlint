import { parseCached } from "./parse-cache.js";
import type {
  AssignmentTarget,
  BindingPattern,
  Declaration,
  Expression,
  Program,
  Statement,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { isTestFile } from "./module.js";
import { findModuleImporters } from "./repository.js";
import type { ModuleImporter } from "./repository.js";

export type ImportTimeSideEffectKind =
  | "io"
  | "network"
  | "timer"
  | "worker"
  | "process"
  | "async"
  | "mutation"
  | "unclassified-call";

export type ImportTimeSideEffect = {
  source: string;
  kind: ImportTimeSideEffectKind;
  callee: string;
};

export type ImportTimeSideEffectEvidence = {
  module: {
    filePath: string;
    moduleSource: string;
    initFunctions: string[];
  };
  sideEffects: ImportTimeSideEffect[];
  repository: {
    importers: ModuleImporter[];
  };
};

const EXCERPT_LIMIT = 500;
const EVIDENCE_LIMIT = 12;

const INIT_FUNCTION_PATTERN = /^(init|initialise|initialize|start|startup|boot|bootstrap|setup|main)$/i;

const PURE_CALLEES = new Set([
  "Object.freeze",
  "Object.seal",
  "Object.preventExtensions",
]);

const TIMER_ROOTS = new Set([
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  "queueMicrotask",
  "requestAnimationFrame",
  "cancelAnimationFrame",
]);

const WORKER_ROOTS = new Set([
  "Worker",
  "spawn",
  "fork",
  "exec",
  "execFile",
  "spawnSync",
  "execSync",
  "execFileSync",
]);

const NETWORK_ROOTS = new Set([
  "fetch",
  "WebSocket",
  "EventSource",
  "XMLHttpRequest",
  "axios",
  "http",
  "https",
  "net",
  "dgram",
  "tls",
  "dns",
]);

const IO_ROOTS = new Set(["fs", "fsp", "fsPromises", "console", "Deno", "Bun"]);

const IO_FUNCTIONS = new Set([
  "readFile",
  "readFileSync",
  "writeFile",
  "writeFileSync",
  "appendFile",
  "appendFileSync",
  "existsSync",
  "mkdir",
  "mkdirSync",
  "readdir",
  "readdirSync",
  "rm",
  "rmSync",
  "copyFile",
  "copyFileSync",
  "rename",
  "renameSync",
  "unlink",
  "unlinkSync",
  "watch",
  "watchFile",
  "createReadStream",
  "createWriteStream",
]);

const PROCESS_EXIT_METHODS = new Set(["exit", "abort", "kill", "_exit"]);

const ASYNC_METHODS = new Set(["then", "catch", "finally"]);

function unwrapExpression(node: Expression): Expression {
  let current = node;
  while (
    current.type === "TSAsExpression"
    || current.type === "TSSatisfiesExpression"
    || current.type === "TSNonNullExpression"
    || current.type === "TSTypeAssertion"
    || current.type === "TSInstantiationExpression"
    || current.type === "ParenthesizedExpression"
  ) {
    current = current.expression;
  }
  if (current.type === "ChainExpression") return unwrapExpression(current.expression);
  return current;
}

function dottedName(node: Expression): string | undefined {
  const target = unwrapExpression(node);
  if (target.type === "Identifier") return target.name;
  if (target.type === "ThisExpression") return "this";
  if (target.type === "MemberExpression") {
    const object = dottedName(target.object);
    if (!object || target.computed) return object;
    if (target.property.type === "PrivateIdentifier") return `${object}.#${target.property.name}`;
    return `${object}.${target.property.name}`;
  }
  return undefined;
}

function rootName(dotted: string): string {
  const root = dotted.split(".")[0];
  return root ?? dotted;
}

function classifyCallee(callee: Expression, calleeText: string): ImportTimeSideEffectKind | undefined {
  if (callee.type === "ImportExpression") return "async";
  if (PURE_CALLEES.has(calleeText)) return undefined;
  const root = rootName(calleeText);
  if (root === "require") return undefined;
  if (TIMER_ROOTS.has(root)) return "timer";
  if (WORKER_ROOTS.has(root) || WORKER_ROOTS.has(calleeText)) return "worker";
  if (NETWORK_ROOTS.has(root)) return "network";
  if (IO_ROOTS.has(root) || IO_FUNCTIONS.has(root) || calleeText.startsWith("fs.")) return "io";
  if (root === "process") {
    const method = calleeText.split(".")[1];
    if (method && PROCESS_EXIT_METHODS.has(method)) return "process";
    return "unclassified-call";
  }
  const unwrapped = unwrapExpression(callee);
  if (
    unwrapped.type === "MemberExpression"
    && !unwrapped.computed
    && unwrapped.property.type === "Identifier"
    && ASYNC_METHODS.has(unwrapped.property.name)
  ) {
    return "async";
  }
  return "unclassified-call";
}

function classifyNew(calleeText: string): ImportTimeSideEffectKind | undefined {
  const root = rootName(calleeText);
  if (WORKER_ROOTS.has(root)) return "worker";
  if (root === "WebSocket" || root === "EventSource" || root === "XMLHttpRequest") return "network";
  return undefined;
}

function excerpt(source: string, start: number, end: number): string {
  const text = source.slice(start, end);
  return text.length > EXCERPT_LIMIT ? text.slice(0, EXCERPT_LIMIT) : text;
}

type PendingEffect = {
  kind: ImportTimeSideEffectKind;
  callee: string;
  start: number;
  end: number;
};

function effectsOfExpression(expression: Expression): PendingEffect[] {
  const node = unwrapExpression(expression);
  if (node.type === "AwaitExpression") {
    const inner = unwrapExpression(node.argument);
    if (inner.type === "CallExpression") {
      const callee = dottedName(inner.callee) ?? "awaited-expression";
      return [{ kind: "async", callee, start: node.start, end: node.end }];
    }
    return [{
      kind: "async",
      callee: dottedName(inner) ?? "awaited-expression",
      start: node.start,
      end: node.end,
    }];
  }
  if (node.type === "CallExpression") {
    if (node.callee.type === "ImportExpression") {
      return [{ kind: "async", callee: "import()", start: node.start, end: node.end }];
    }
    const text = dottedName(node.callee);
    if (!text) {
      return [{ kind: "unclassified-call", callee: "unknown-call", start: node.start, end: node.end }];
    }
    const kind = classifyCallee(node.callee, text);
    return kind ? [{ kind, callee: text, start: node.start, end: node.end }] : [];
  }
  if (node.type === "NewExpression") {
    const text = dottedName(node.callee);
    if (!text) return [];
    const kind = classifyNew(text);
    return kind ? [{ kind, callee: text, start: node.start, end: node.end }] : [];
  }
  if (node.type === "TaggedTemplateExpression") {
    const text = dottedName(node.tag) ?? "tagged-template";
    return [{ kind: "unclassified-call", callee: text, start: node.start, end: node.end }];
  }
  if (node.type === "SequenceExpression") {
    return node.expressions.flatMap(effectsOfExpression);
  }
  return [];
}

function mutationOfTarget(left: AssignmentTarget, start: number, end: number): PendingEffect | undefined {
  if (left.type === "ArrayPattern" || left.type === "ObjectPattern") return undefined;
  const text = dottedName(left);
  if (!text) return undefined;
  const segments = text.split(".");
  if (segments[0] === "process" && segments[1] === "env") {
    return { kind: "mutation", callee: text, start, end };
  }
  if (segments[0] === "globalThis" || segments[0] === "global" || segments[0] === "self") {
    return { kind: "mutation", callee: text, start, end };
  }
  return undefined;
}

function effectsOfDeclaration(declaration: Declaration): PendingEffect[] {
  if (declaration.type === "VariableDeclaration") {
    return declaration.declarations.flatMap((item) =>
      item.init ? effectsOfExpression(item.init) : []
    );
  }
  return [];
}

function namedInit(pattern: BindingPattern): string | undefined {
  return pattern.type === "Identifier" ? pattern.name : undefined;
}

function scanDeclaration(declaration: Declaration, add: (name: string | undefined) => void): void {
  if (declaration.type === "FunctionDeclaration") {
    add(declaration.id?.name);
    return;
  }
  if (declaration.type !== "VariableDeclaration") return;
  for (const item of declaration.declarations) {
    const init = item.init ? unwrapExpression(item.init) : undefined;
    if (init?.type === "ArrowFunctionExpression" || init?.type === "FunctionExpression") {
      add(namedInit(item.id));
    }
  }
}

function initFunctionNames(program: Program): string[] {
  const names: string[] = [];
  const add = (name: string | undefined): void => {
    if (name && INIT_FUNCTION_PATTERN.test(name) && !names.includes(name)) names.push(name);
  };
  for (const statement of program.body) {
    if (statement.type === "ExportNamedDeclaration") {
      if (statement.declaration) scanDeclaration(statement.declaration, add);
      continue;
    }
    if (statement.type === "FunctionDeclaration" || statement.type === "VariableDeclaration") {
      scanDeclaration(statement, add);
    }
  }
  return names;
}

export function buildImportTimeSideEffectEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ImportTimeSideEffectEvidence | undefined {
  if (candidate.kind !== "module") return undefined;
  if (isTestFile(candidate.filePath)) return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;

  const pending: PendingEffect[] = [];
  const collectStatement = (statement: Statement): void => {
    if (statement.type === "ExpressionStatement") {
      pending.push(...effectsOfExpression(statement.expression));
      const target = unwrapExpression(statement.expression);
      if (target.type === "AssignmentExpression") {
        const mutation = mutationOfTarget(target.left, statement.start, statement.end);
        if (mutation) pending.push(mutation);
      }
      return;
    }
    if (statement.type === "ExportNamedDeclaration" && statement.declaration) {
      pending.push(...effectsOfDeclaration(statement.declaration));
      return;
    }
    if (statement.type === "ExportDefaultDeclaration") {
      const value = statement.declaration;
      if (
        value.type === "FunctionDeclaration"
        || value.type === "ClassDeclaration"
        || value.type === "TSInterfaceDeclaration"
      ) return;
      pending.push(...effectsOfExpression(value));
      return;
    }
    if (statement.type === "VariableDeclaration") {
      pending.push(...effectsOfDeclaration(statement));
    }
  };
  for (const statement of parsed.program.body) collectStatement(statement);

  if (pending.length === 0) return undefined;

  return {
    module: {
      filePath: candidate.filePath,
      moduleSource: owner.source.slice(0, 16_000),
      initFunctions: initFunctionNames(parsed.program),
    },
    sideEffects: pending.slice(0, EVIDENCE_LIMIT).map(({ kind, callee, start, end }) => ({
      source: excerpt(owner.source, start, end),
      kind,
      callee,
    })),
    repository: {
      importers: findModuleImporters(candidate.filePath, projectFiles),
    },
  };
}
