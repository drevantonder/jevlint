import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Node, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  nestedFunctionRanges,
} from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type {
  FunctionCaller,
  FunctionNode,
  RelatedProjectModule,
} from "./repository.js";

export type DeploymentAssumption = {
  expression: string;
  kind: "localhost-url" | "hardcoded-port" | "absolute-path" | "env-name-branch" | "plain-http-url";
};

export type DeploymentCoupledAssumptionEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  assumptions: DeploymentAssumption[];
  configuration: {
    configReads: string[];
    configSources: {
      filePath: string;
      excerpt: string;
    }[];
  };
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

const LOCALHOST_PATTERN = /localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/i;
const PORT_PATTERN = /:\d{2,5}(?:\/|$)/;
const HTTP_PATTERN = /^http:\/\//i;
function looksLikeFilesystemPath(text: string): boolean {
  if (SYSTEM_PATH_PATTERN.test(text)) return true;
  if (/^[A-Za-z]:\\|^\\\\/.test(text)) return true;
  if (!text.startsWith("/")) return false;
  if (/\.\w{1,5}$/.test(text)) return true;
  return text.split("/").length > 3;
}
const SYSTEM_PATH_PATTERN = /\/(?:var|etc|home|usr|opt|tmp)\//;
const ENV_NAME_PATTERN = /^(?:production|staging|development|test|prod|stage|dev)$/i;
const CONFIG_READ_PATTERN = /process\.env|getConfig|appConfig|serverConfig|loadConfig|readConfig|getEnv|config\./i;
const CONFIG_FILE_PATTERN = /config|setting|\.env|deploy|environment/i;
const ROUTE_CALL_PATTERN = /^(?:fetch|get|post|put|patch|delete|head|options|all|use|route|register|redirect|navigate)$/i;

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function literalText(node: { raw: string | null }): string | null {
  const raw = node.raw;
  if (!raw || raw.length < 2) return null;
  const quote = raw[0];
  if ((quote === '"' || quote === "'" || quote === "`") && raw.endsWith(quote)) {
    return raw.slice(1, -1);
  }
  return null;
}

function moduleLinesMatching(source: string, pattern: RegExp, limit: number): string[] {
  const result: string[] = [];
  for (const line of source.split("\n")) {
    if (pattern.test(line)) {
      result.push(line.trim().slice(0, 240));
      if (result.length >= limit) break;
    }
  }
  return result;
}

export function buildDeploymentCoupledAssumptionEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DeploymentCoupledAssumptionEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn: FunctionNode | undefined = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested = nestedFunctionRanges(parsed.program, fn);
  const direct = (node: NodeRange): boolean =>
    node.start >= fn.start && node.end <= fn.end && belongsDirectlyToFunction(node, nested);
  const program: Program = parsed.program;
  const source = ownerFile.source;

  const assumptions: DeploymentAssumption[] = [];
  const seen = new Set<string>();
  const push = (node: Node, kind: DeploymentAssumption["kind"]): void => {
    const expression = nodeSource(node, source);
    if (seen.has(expression)) return;
    seen.add(expression);
    assumptions.push({ expression, kind });
  };

  const enclosingCallNames = (node: NodeRange): string[] => {
    const names: string[] = [];
    new Visitor({
      CallExpression(call) {
        if (call.start > node.start || call.end < node.end) return;
        if (call.callee.type === "Identifier") {
          names.push(call.callee.name);
          return;
        }
        if (call.callee.type === "MemberExpression" && call.callee.property.type === "Identifier") {
          names.push(call.callee.property.name);
        }
      },
    }).visit(program);
    return names;
  };

  const isRoutePath = (node: NodeRange): boolean =>
    enclosingCallNames(node).some((name) => ROUTE_CALL_PATTERN.test(name));

  new Visitor({
    Literal(node) {
      if (!direct(node)) return;
      const text = literalText(node);
      if (!text) return;
      if (LOCALHOST_PATTERN.test(text)) {
        push(node, "localhost-url");
      } else if (HTTP_PATTERN.test(text)) {
        push(node, "plain-http-url");
      } else if (/^https?:\/\//i.test(text) && PORT_PATTERN.test(text)) {
        push(node, "hardcoded-port");
      } else if (ENV_NAME_PATTERN.test(text)) {
        push(node, "env-name-branch");
      } else if (looksLikeFilesystemPath(text) && !isRoutePath(node)) {
        push(node, "absolute-path");
      }
    },
    TemplateLiteral(node) {
      if (!direct(node)) return;
      const text = nodeSource(node, source);
      if (LOCALHOST_PATTERN.test(text)) push(node, "localhost-url");
      else if (/^`http:\/\//i.test(text)) push(node, "plain-http-url");
    },
    BinaryExpression(node) {
      if (!direct(node)) return;
      if (node.operator !== "==" && node.operator !== "===" && node.operator !== "!=" && node.operator !== "!==") {
        return;
      }
      for (const side of [node.left, node.right]) {
        if (side.type === "Literal" && ENV_NAME_PATTERN.test(literalText(side) ?? "")) {
          push(node, "env-name-branch");
          break;
        }
      }
    },
  }).visit(program);
  if (assumptions.length === 0) return undefined;

  const configReads = moduleLinesMatching(source, CONFIG_READ_PATTERN, 8);
  const configSources: DeploymentCoupledAssumptionEvidence["configuration"]["configSources"] = [];
  for (const file of projectFiles) {
    if (file.filePath === candidate.filePath) continue;
    if (!CONFIG_FILE_PATTERN.test(file.filePath) && !CONFIG_READ_PATTERN.test(file.source)) continue;
    const lines = moduleLinesMatching(file.source, CONFIG_READ_PATTERN, 4);
    if (lines[0]) configSources.push({ filePath: file.filePath, excerpt: lines.join("\n") });
    if (configSources.length >= 6) break;
  }

  const name = functionName(program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: source.slice(0, 16_000),
    },
    assumptions,
    configuration: { configReads, configSources },
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(candidate.filePath, program, projectFiles),
    },
  };
}
