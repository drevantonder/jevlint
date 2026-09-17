import { parseSync, Visitor } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller, ModuleImport } from "./repository.js";

const ADAPTER_PATH_PARTS = new Set([
  "adapter",
  "adapters",
  "client",
  "clients",
  "controller",
  "controllers",
  "gateway",
  "gateways",
  "http",
  "infrastructure",
  "messaging",
  "persistence",
  "repository",
  "repositories",
  "route",
  "routes",
]);
const ADAPTER_MODULE = /^(?:express|fastify|koa|hono|@nestjs\/|next\/server|stripe|pg$|postgres|mysql|mysql2|@prisma\/client|typeorm|sequelize|drizzle-orm|mongoose|@mikro-orm\/|knex|kysely|redis|ioredis|kafkajs|amqplib|@aws-sdk\/|twilio|nodemailer|@grpc\/|ws$)/;

type AdapterDecision = {
  kind: "if" | "switch" | "conditional";
  condition: string;
  outcome: string;
};

export type DomainPolicyInAdapterEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  adapter: {
    pathSignal: string | null;
    imports: ModuleImport[];
    externalImports: ModuleImport[];
    relatedModules: Array<{ filePath: string; source: string }>;
  };
  decisions: AdapterDecision[];
  callers: FunctionCaller[];
  consumers: Array<{ filePath: string; source: string }>;
};

function pathSignal(filePath: string): string | null {
  return filePath.split("/").find((part) => ADAPTER_PATH_PARTS.has(part.toLowerCase())) ?? null;
}

function consumerModules(
  callers: FunctionCaller[],
  projectFiles: ProjectFile[],
): Array<{ filePath: string; source: string }> {
  const paths = new Set(callers.map(({ filePath }) => filePath));
  return projectFiles
    .filter(({ filePath }) => paths.has(filePath))
    .slice(0, 20)
    .map(({ filePath, source }) => ({ filePath, source: source.slice(0, 12_000) }));
}

export function buildDomainPolicyInAdapterEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DomainPolicyInAdapterEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find(({ filePath }) => filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some(({ severity }) => severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const imports = moduleImports(parsed.program);
  const externalImports = imports.filter(({ source }) => ADAPTER_MODULE.test(source));
  const modulePathSignal = pathSignal(owner.filePath);
  if (!modulePathSignal && externalImports.length === 0) return undefined;

  const decisions: AdapterDecision[] = [];
  new Visitor({
    IfStatement(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      decisions.push({
        kind: "if",
        condition: owner.source.slice(node.test.start, node.test.end),
        outcome: owner.source.slice(node.consequent.start, node.consequent.end),
      });
    },
    SwitchStatement(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      decisions.push({
        kind: "switch",
        condition: owner.source.slice(node.discriminant.start, node.discriminant.end),
        outcome: owner.source.slice(node.start, node.end),
      });
    },
    ConditionalExpression(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      decisions.push({
        kind: "conditional",
        condition: owner.source.slice(node.test.start, node.test.end),
        outcome: owner.source.slice(node.start, node.end),
      });
    },
  }).visit(parsed.program);
  if (decisions.length === 0) return undefined;

  const relatedModules = imports.flatMap((item) => {
    const resolved = resolveModule(owner.filePath, item.source, projectFiles);
    return resolved
      ? [{ filePath: resolved.filePath, source: resolved.source.slice(0, 12_000) }]
      : [];
  }).filter((module, index, modules) =>
    modules.findIndex(({ filePath }) => filePath === module.filePath) === index,
  ).slice(0, 12);
  const callers = findFunctionCallers(owner.filePath, name, projectFiles);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    adapter: {
      pathSignal: modulePathSignal,
      imports,
      externalImports,
      relatedModules,
    },
    decisions,
    callers,
    consumers: consumerModules(callers, projectFiles),
  };
}
