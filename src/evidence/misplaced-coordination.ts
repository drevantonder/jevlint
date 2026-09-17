import { parseSync, Visitor } from "oxc-parser";
import type { CallExpression, Class, MethodDefinition, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  calleeRootName,
  findDirectFunction,
  isInsideNestedFunction,
  moduleImports,
  nestedFunctionRanges,
  resolveModule,
} from "./repository.js";
import type { NodeRange } from "./function-scope.js";

type CoordinatorCall = {
  expression: string;
  line: number;
};

type CoordinationCollaborator = {
  source: string;
  ownership: "project-module" | "external-package" | "unresolved";
  role: string | null;
  isOwnRepository: boolean;
  bindings: Array<{ local: string; imported: string }>;
  module: { filePath: string; source: string } | null;
  calls: CoordinatorCall[];
};

type MethodCaller = {
  filePath: string;
  call: string;
  line: number;
};

export type MisplacedCoordinationEvidence = {
  method: {
    name: string;
    kind: string;
    static: boolean;
    className: string;
    filePath: string;
    source: string;
    moduleSource: string;
    isCoordinatorHome: boolean;
    coordinatorSignal: string | null;
    isLifecycleHook: boolean;
  };
  ownership: {
    ownFieldReads: string[];
    ownFieldReadCount: number;
  };
  collaborators: CoordinationCollaborator[];
  callers: MethodCaller[];
};

const ROLE_TOKENS: Array<{ role: string; tokens: string[] }> = [
  { role: "service", tokens: ["service", "services"] },
  { role: "use-case", tokens: ["usecase", "usecases"] },
  {
    role: "orchestrator",
    tokens: [
      "orchestrator",
      "orchestrators",
      "orchestration",
      "coordinator",
      "workflow",
      "workflows",
      "facade",
      "application",
    ],
  },
  {
    role: "persistence",
    tokens: ["repository", "repositories", "persistence", "dao", "store", "storage", "database"],
  },
  {
    role: "gateway",
    tokens: ["gateway", "gateways", "client", "clients", "api", "http", "grpc", "adapter", "adapters"],
  },
  {
    role: "notifier",
    tokens: [
      "mailer",
      "mail",
      "email",
      "sms",
      "notifier",
      "notification",
      "notifications",
      "notify",
      "push",
      "sender",
      "messaging",
    ],
  },
  { role: "payment", tokens: ["payment", "payments", "billing", "stripe", "paypal", "checkout"] },
];

const EFFECT_PACKAGE =
  /^(stripe|twilio|nodemailer|@sendgrid\/|resend|onesignal|pusher|ably|kafkajs|amqplib|ioredis|redis|pg$|postgres|mysql|mysql2|mongodb|mongoose|@prisma\/client|typeorm|sequelize|drizzle-orm|@mikro-orm\/|knex|kysely|@aws-sdk\/)/;

const COORDINATOR_HOME_TOKENS = new Set([
  "service",
  "services",
  "usecase",
  "usecases",
  "orchestrator",
  "orchestration",
  "workflow",
  "workflows",
  "facade",
  "facades",
  "coordinator",
  "application",
]);

const OWN_REPOSITORY_TOKENS = new Set([
  "repository",
  "repositories",
  "dao",
  "store",
  "storage",
  "persistence",
]);

const LIFECYCLE_HOOKS = new Set([
  "constructor",
  "ngOnInit",
  "ngOnDestroy",
  "ngOnChanges",
  "ngAfterViewInit",
  "componentDidMount",
  "componentDidUpdate",
  "componentWillUnmount",
  "mounted",
  "unmounted",
  "created",
  "destroyed",
  "setup",
  "connectedCallback",
  "disconnectedCallback",
]);

function tokensOf(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function roleOf(source: string): string | null {
  const tokens = new Set(tokensOf(source));
  for (const { role, tokens: signals } of ROLE_TOKENS) {
    if (signals.some((signal) => tokens.has(signal))) return role;
  }
  if (EFFECT_PACKAGE.test(source)) return "external-effect";
  return null;
}

function coordinatorSignalOf(filePath: string, className: string): string | null {
  const tokens = [...tokensOf(filePath), ...tokensOf(className)];
  return tokens.find((token) => COORDINATOR_HOME_TOKENS.has(token)) ?? null;
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function methodKeyName(source: string, definition: MethodDefinition): string {
  if (definition.key.type === "Identifier") return definition.key.name;
  if (definition.key.type === "PrivateIdentifier") return `#${definition.key.name}`;
  return source.slice(definition.key.start, definition.key.end);
}

function collectClasses(program: Program, candidate: Candidate): Class[] {
  const classes: Class[] = [];
  new Visitor({
    ClassDeclaration(node) {
      if (node.start <= candidate.start && candidate.end <= node.end) classes.push(node);
    },
    ClassExpression(node) {
      if (node.start <= candidate.start && candidate.end <= node.end) classes.push(node);
    },
  }).visit(program);
  return classes;
}

function findMethod(
  classes: Class[],
  candidate: Candidate,
): { classNode: Class; definition: MethodDefinition } | undefined {
  const enclosing = classes
    .filter((node) => node.start <= candidate.start && candidate.end <= node.end)
    .sort((left, right) => right.end - right.start - (left.end - left.start))
    .pop();
  if (!enclosing) return undefined;
  for (const element of enclosing.body.body) {
    if (element.type !== "MethodDefinition") continue;
    if (element.value.start === candidate.start && element.value.end === candidate.end) {
      return { classNode: enclosing, definition: element };
    }
  }
  return undefined;
}

function ownFieldReads(
  program: Program,
  candidate: Candidate,
  nested: NodeRange[],
) {
  const reads: string[] = [];
  new Visitor({
    MemberExpression(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (isInsideNestedFunction(node, nested)) return;
      if (node.object.type !== "ThisExpression") return;
      if (node.property.type === "Identifier") reads.push(node.property.name);
      else if (node.property.type === "PrivateIdentifier") reads.push(`#${node.property.name}`);
    },
  }).visit(program);
  return { names: [...new Set(reads)].sort().slice(0, 20), count: reads.length };
}

function collaboratorCalls(
  program: Program,
  source: string,
  candidate: Candidate,
  nested: NodeRange[],
  importsByLocal: Map<string, { source: string; local: string; imported: string }>,
): Map<string, CoordinatorCall[]> {
  const callsBySource = new Map<string, CoordinatorCall[]>();
  new Visitor({
    CallExpression(call: CallExpression) {
      if (call.start < candidate.start || call.end > candidate.end) return;
      if (isInsideNestedFunction(call, nested)) return;
      const root = calleeRootName(call.callee);
      if (!root) return;
      const imported = importsByLocal.get(root);
      if (!imported) return;
      const calls = callsBySource.get(imported.source) ?? [];
      calls.push({
        expression: source.slice(call.start, call.end).slice(0, 200),
        line: lineAt(source, call.start),
      });
      callsBySource.set(imported.source, calls);
    },
  }).visit(program);
  return callsBySource;
}

function findMethodCallers(
  methodName: string,
  projectFiles: ProjectFile[],
): MethodCaller[] {
  const callers: MethodCaller[] = [];
  for (const file of projectFiles) {
    const parsed = parseSync(file.filePath, file.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    new Visitor({
      CallExpression(call: CallExpression) {
        if (call.callee.type !== "MemberExpression") return;
        const { property } = call.callee;
        const name = property.type === "Identifier"
          ? property.name
          : property.type === "PrivateIdentifier"
            ? `#${property.name}`
            : undefined;
        if (name !== methodName) return;
        callers.push({
          filePath: file.filePath,
          call: file.source.slice(call.start, call.end).slice(0, 200),
          line: lineAt(file.source, call.start),
        });
      },
    }).visit(parsed.program);
    if (callers.length >= 20) break;
  }
  return callers.slice(0, 20);
}

export function buildMisplacedCoordinationEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): MisplacedCoordinationEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const method = findMethod(collectClasses(parsed.program, candidate), candidate);
  if (!method) return undefined;
  const className = method.classNode.id?.name ?? "(anonymous class)";
  const name = methodKeyName(owner.source, method.definition);

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const imports = moduleImports(parsed.program);
  const importsByLocal = new Map(imports.map((item) => [item.local, item]));
  const callsBySource = collaboratorCalls(
    parsed.program,
    owner.source,
    candidate,
    nested,
    importsByLocal,
  );
  if (callsBySource.size === 0) return undefined;

  const classTokens = new Set(tokensOf(className));
  const collaborators: CoordinationCollaborator[] = [...callsBySource]
    .slice(0, 8)
    .map(([source, calls]): CoordinationCollaborator => {
      const target = resolveModule(owner.filePath, source, projectFiles);
      const sourceTokens = new Set(tokensOf(source));
      const sharesClassToken = [...classTokens].some((token) =>
        token.length > 2 && sourceTokens.has(token)
      );
      const isOwnRepository = sharesClassToken
        && [...sourceTokens].some((token) => OWN_REPOSITORY_TOKENS.has(token));
      return {
        source,
        ownership: target
          ? "project-module"
          : source.startsWith(".")
            ? "unresolved"
            : "external-package",
        role: roleOf(source),
        isOwnRepository,
        bindings: imports
          .filter((item) => item.source === source)
          .map(({ local, imported }) => ({ local, imported })),
        module: target
          ? { filePath: target.filePath, source: target.source.slice(0, 6_000) }
          : null,
        calls: calls.slice(0, 20),
      };
    });
  if (collaborators.every(({ ownership }) => ownership === "unresolved")) return undefined;

  const fields = ownFieldReads(parsed.program, candidate, nested);
  const signal = coordinatorSignalOf(owner.filePath, className);

  return {
    method: {
      name,
      kind: method.definition.kind,
      static: method.definition.static,
      className,
      filePath: owner.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
      isCoordinatorHome: signal !== null,
      coordinatorSignal: signal,
      isLifecycleHook: LIFECYCLE_HOOKS.has(name),
    },
    ownership: {
      ownFieldReads: fields.names,
      ownFieldReadCount: fields.count,
    },
    collaborators,
    callers: findMethodCallers(name, projectFiles),
  };
}
