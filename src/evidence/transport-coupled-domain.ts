import { parseSync, Visitor } from "oxc-parser";
import type { MemberExpression, ParamPattern } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionCaller, ModuleImport } from "./repository.js";

const TRANSPORT_MODULE = /^(?:node:)?https?$|^(?:express|fastify|koa|hono|@hapi\/hapi|@nestjs\/(?:common|core)|next\/server|@grpc\/|graphql|ws$)/;
const TRANSPORT_TYPE = /\b(?:Request|Response|NextRequest|NextResponse|FastifyRequest|FastifyReply|Context|HttpContext|IncomingMessage|ServerResponse)\b/;
const CONVENTIONAL_PARAMETER = /^(?:req|res|request|response|ctx|context|reply)$/i;
const TRANSPORT_MEMBER = new Set([
  "body",
  "cookie",
  "cookies",
  "header",
  "headers",
  "json",
  "method",
  "params",
  "query",
  "redirect",
  "send",
  "setHeader",
  "status",
  "url",
  "user",
  "userAgent",
]);

export type TransportCoupledDomainEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  transport: {
    imports: ModuleImport[];
    parameters: Array<{ name: string; source: string }>;
    operations: string[];
  };
  callers: FunctionCaller[];
};

function parameterName(parameter: ParamPattern): string | undefined {
  if (parameter.type === "Identifier") return parameter.name;
  if (parameter.type === "TSParameterProperty") return parameterName(parameter.parameter);
  if (parameter.type === "RestElement" && parameter.argument.type === "Identifier") {
    return parameter.argument.name;
  }
  return undefined;
}

function memberName(member: MemberExpression): string | undefined {
  if (member.computed) return undefined;
  return member.property.type === "Identifier" ? member.property.name : undefined;
}

function mentionsIdentifier(source: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(source);
}

export function buildTransportCoupledDomainEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): TransportCoupledDomainEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find(({ filePath }) => filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some(({ severity }) => severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const relevantImports = moduleImports(parsed.program).filter((item) =>
    TRANSPORT_MODULE.test(item.source) && mentionsIdentifier(candidate.source, item.local),
  );
  const importedTypes = new Set(relevantImports.map(({ local }) => local));
  const parameterEntries = fn.params.flatMap((parameter) => {
    const parameterSource = owner.source.slice(parameter.start, parameter.end);
    const parameterIdentifier = parameterName(parameter);
    if (!parameterIdentifier) return [];
    const typedForTransport = TRANSPORT_TYPE.test(parameterSource)
      || [...importedTypes].some((local) => mentionsIdentifier(parameterSource, local));
    return [{
      name: parameterIdentifier,
      source: parameterSource,
      typedForTransport,
    }];
  });
  const possibleTransportParameters = new Set(parameterEntries
    .filter(({ name: parameterName, typedForTransport }) =>
      typedForTransport || CONVENTIONAL_PARAMETER.test(parameterName),
    )
    .map(({ name: parameterName }) => parameterName));

  const operations = new Set<string>();
  new Visitor({
    MemberExpression(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      const property = memberName(node);
      if (!property || !TRANSPORT_MEMBER.has(property)) return;
      const source = owner.source.slice(node.start, node.end);
      if ([...possibleTransportParameters].some((parameter) =>
        source.startsWith(`${parameter}.`) || source.startsWith(`${parameter}[`),
      )) operations.add(source);
    },
    NewExpression(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (
        node.callee.type === "Identifier"
        && (node.callee.name === "Response" || importedTypes.has(node.callee.name))
      ) operations.add(owner.source.slice(node.start, node.end));
    },
  }).visit(parsed.program);

  const parameters = parameterEntries
    .filter(({ name: parameterName, typedForTransport }) =>
      typedForTransport
      || [...operations].some((operation) => operation.startsWith(`${parameterName}.`)),
    )
    .map(({ name: parameterName, source }) => ({ name: parameterName, source }));
  if (parameters.length === 0 && operations.size === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    transport: {
      imports: relevantImports,
      parameters,
      operations: [...operations],
    },
    callers: findFunctionCallers(owner.filePath, name, projectFiles),
  };
}
