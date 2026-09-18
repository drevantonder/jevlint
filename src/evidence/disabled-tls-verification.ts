import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, nestedFunctionRanges } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type TlsBypassKind = "rejectUnauthorized" | "tls-env" | "checkServerIdentity" | "verify";

export type TlsBypass = {
  kind: TlsBypassKind;
  line: number;
  call: string;
};

export type DisabledTlsVerificationEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    fileRole: "test" | "docs" | "service";
    source: string;
  };
  bypasses: TlsBypass[];
  clientImports: string[];
  scope: "call" | "agent" | "global";
  callers: FunctionCaller[];
};

const TEST_PATH_PATTERN = /(^|\/)(test|tests|__tests__|__fixtures__|fixtures?|mocks?|spec)(^|\/|\.)|\.(test|spec)\.[cm]?[jt]sx?$/i;
const DOCS_PATH_PATTERN = /(^|\/)(docs|examples?)(^|\/)/i;
const CLIENT_IMPORT_PATTERN = /^(node:)?(https|tls|http2|net)$|axios|node-fetch|undici|got|superagent|elasticsearch|@elastic|pg|ioredis|redis|mqtt|amqplib|nodemailer|ws$/i;
const AGENT_CALLEE_PATTERN = /Agent$/;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function fileRole(filePath: string): "test" | "docs" | "service" {
  if (TEST_PATH_PATTERN.test(filePath)) return "test";
  if (DOCS_PATH_PATTERN.test(filePath)) return "docs";
  return "service";
}

function unquoted(raw: string): string | undefined {
  const quote = raw[0];
  if (raw.length >= 2 && (quote === '"' || quote === "'") && raw.endsWith(quote)) {
    return raw.slice(1, -1);
  }
  return undefined;
}

export function buildDisabledTlsVerificationEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DisabledTlsVerificationEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const direct = (node: { start: number; end: number }): boolean =>
    node.start >= candidate.start && node.end <= candidate.end
    && belongsDirectlyToFunction(node, nested);

  const found: { kind: TlsBypassKind; start: number; end: number }[] = [];
  const agentRanges: { start: number; end: number }[] = [];

  new Visitor({
    NewExpression(node) {
      if (!direct(node)) return;
      const callee = owner.source.slice(node.callee.start, node.callee.end);
      if (AGENT_CALLEE_PATTERN.test(callee)) agentRanges.push({ start: node.start, end: node.end });
    },
    CallExpression(node) {
      if (!direct(node)) return;
      const callee = owner.source.slice(node.callee.start, node.callee.end);
      if (AGENT_CALLEE_PATTERN.test(callee)) agentRanges.push({ start: node.start, end: node.end });
    },
    Property(node) {
      if (!direct(node)) return;
      const key = node.key;
      const propertyName = key.type === "Identifier"
        ? key.name
        : key.type === "Literal"
          ? unquoted(owner.source.slice(key.start, key.end))
          : undefined;
      if (propertyName === undefined) return;
      const valueText = owner.source.slice(node.value.start, node.value.end).trim();
      if (propertyName === "rejectUnauthorized" && valueText === "false") {
        found.push({ kind: "rejectUnauthorized", start: node.start, end: node.end });
      } else if (propertyName === "verify" && valueText === "false") {
        found.push({ kind: "verify", start: node.start, end: node.end });
      } else if (
        propertyName === "checkServerIdentity"
        && (node.value.type === "ArrowFunctionExpression" || node.value.type === "FunctionExpression")
      ) {
        found.push({ kind: "checkServerIdentity", start: node.start, end: node.end });
      }
    },
    AssignmentExpression(node) {
      if (!direct(node)) return;
      const left = owner.source.slice(node.left.start, node.left.end)
        .replace(/\[(["'])(.*?)\1\]/g, ".$2");
      const right = owner.source.slice(node.right.start, node.right.end).trim();
      if (left === "process.env.NODE_TLS_REJECT_UNAUTHORIZED" && (right === '"0"' || right === "'0'")) {
        found.push({ kind: "tls-env", start: node.start, end: node.end });
        return;
      }
      if (node.left.type === "MemberExpression") {
        const property = node.left.property;
        const propertyName = property.type === "Identifier"
          ? property.name
          : property.type === "Literal"
            ? unquoted(owner.source.slice(property.start, property.end))
            : undefined;
        if (propertyName !== undefined && (propertyName === "rejectUnauthorized" || propertyName === "verify") && right === "false") {
          found.push({ kind: propertyName, start: node.start, end: node.end });
        }
      }
    },
  }).visit(parsed.program);
  if (found.length === 0) return undefined;

  const scope: DisabledTlsVerificationEvidence["scope"] = found.some(({ kind }) => kind === "tls-env")
    ? "global"
    : found.some(({ start, end }) => agentRanges.some((range) => start >= range.start && end <= range.end))
      ? "agent"
      : "call";

  const clientImports = moduleImports(parsed.program)
    .map(({ source }) => source)
    .filter((source, index, all) => CLIENT_IMPORT_PATTERN.test(source) && all.indexOf(source) === index)
    .slice(0, 10);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      fileRole: fileRole(candidate.filePath),
      source: candidate.source,
    },
    bypasses: found.slice(0, 10).map(({ kind, start, end }) => ({
      kind,
      line: lineAt(owner.source, start),
      call: owner.source.slice(start, end).slice(0, 300),
    })),
    clientImports,
    scope,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
