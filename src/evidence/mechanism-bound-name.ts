import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type MechanismBoundName = {
  name: string;
  kind: "function" | "local";
  mechanismTokens: string[];
  connector: string | null;
  source: string;
};

export type MechanismBoundNameEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  mechanismNames: MechanismBoundName[];
  operations: string[];
  siblings: { name: string }[];
  callers: FunctionCaller[];
};

// Tokens naming an implementation choice rather than a caller goal. A name
// carrying one of these would have to change if the algorithm changed while
// the outcome stayed the same. Container words (list, array, map, set, dict,
// collection) are deliberately excluded: they belong to jev/no-deceptive-name.
const MECHANISM_TOKENS = new Set([
  "loop",
  "loops",
  "recursion",
  "recursive",
  "iterative",
  "iteration",
  "hash",
  "hashed",
  "hashing",
  "regex",
  "regexp",
  "linked",
  "tree",
  "trie",
  "graph",
  "stack",
  "queue",
  "heap",
  "buffer",
  "pointer",
  "binary",
  "linear",
  "brute",
  "byte",
  "bytes",
]);

// Phrasing that attaches a mechanism to a goal: findUserByLoop, parseWithRegex.
const MECHANISM_CONNECTORS = new Set(["by", "with", "using", "via", "through"]);

function splitName(name: string): string[] {
  return name
    .replace(/^_+/, "")
    .split(/(?=[A-Z])|_+|[^A-Za-z]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
}

function scanName(name: string): { mechanismTokens: string[]; connector: string | null } | null {
  const parts = splitName(name);
  const mechanismTokens = [...new Set(parts.filter((part) => MECHANISM_TOKENS.has(part)))];
  if (mechanismTokens.length === 0) return null;
  let connector: string | null = null;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const head = parts[index];
    const tail = parts[index + 1];
    if (
      head !== undefined
      && tail !== undefined
      && MECHANISM_CONNECTORS.has(head)
      && MECHANISM_TOKENS.has(tail)
    ) {
      connector = head;
      break;
    }
  }
  return { mechanismTokens, connector };
}

export function buildMechanismBoundNameEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): MechanismBoundNameEvidence | undefined {
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
  const direct = (node: { start: number; end: number }): boolean =>
    node.start >= candidate.start
    && node.end <= candidate.end
    && !nested.some((range) => range.start <= node.start && range.end >= node.end);

  const mechanismNames: MechanismBoundName[] = [];
  const scanned = scanName(name);
  if (scanned) {
    mechanismNames.push({
      name,
      kind: "function",
      mechanismTokens: scanned.mechanismTokens,
      connector: scanned.connector,
      source: owner.source.slice(fn.start, fn.end).slice(0, 300),
    });
  }

  new Visitor({
    VariableDeclarator(node) {
      if (!direct(node) || node.id.type !== "Identifier") return;
      const local = scanName(node.id.name);
      if (!local) return;
      mechanismNames.push({
        name: node.id.name,
        kind: "local",
        mechanismTokens: local.mechanismTokens,
        connector: local.connector,
        source: owner.source.slice(node.start, node.end).slice(0, 300),
      });
    },
  }).visit(parsed.program);

  if (mechanismNames.length === 0) return undefined;

  const bodySource = owner.source.slice(candidate.start, candidate.end);
  const operations = new Set<string>();
  const callPattern = /(\.\s*[A-Za-z_$][\w$]*\s*\()|([A-Za-z_$][\w$]*\s*\()/g;
  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(bodySource)) !== null) {
    operations.add(match[0]);
    if (operations.size >= 20) break;
  }

  const siblings = new Set<string>();
  new Visitor({
    FunctionDeclaration(node) {
      if (!node.id || node.id.name === name || siblings.size >= 10) return;
      siblings.add(node.id.name);
    },
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || node.id.name === name || siblings.size >= 10) return;
      if (node.init?.type !== "ArrowFunctionExpression" && node.init?.type !== "FunctionExpression") {
        return;
      }
      siblings.add(node.id.name);
    },
  }).visit(parsed.program);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    mechanismNames: mechanismNames.slice(0, 10),
    operations: [...operations],
    siblings: [...siblings].map((sibling) => ({ name: sibling })),
    callers: findFunctionCallers(owner.filePath, name, projectFiles),
  };
}
