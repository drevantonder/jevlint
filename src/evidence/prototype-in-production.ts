import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type PrototypeMarker = {
  line: number;
  excerpt: string;
};

export type PrototypeSibling = {
  name: string;
  exported: boolean;
};

export type PrototypeInProductionEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  markers: PrototypeMarker[];
  provisional: {
    literalConditions: string[];
    emptyBlocks: number;
  };
  repository: {
    callers: FunctionCaller[];
    siblings: PrototypeSibling[];
  };
};

const MARKER_PATTERN = /\b(prototype|spike|experimental|hack(?:s|ing|ed)?|temporary|workaround|work-around|proof[\s_-]?of[\s_-]?concept|stopgap|tracer[\s_-]?bullet)\b/i;

export function buildPrototypeInProductionEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): PrototypeInProductionEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn: FunctionNode | undefined = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const markers: PrototypeMarker[] = [];
  const candidateText = owner.source.slice(candidate.start, candidate.end);
  const scanLine = (line: string, lineNumber: number): void => {
    if (MARKER_PATTERN.test(line)) {
      markers.push({ line: lineNumber, excerpt: line.trim().slice(0, 160) });
    }
  };
  // Markers in the leading comment block belong to the candidate's changed
  // lines even though the function range starts after them.
  const preceding = owner.source.slice(0, candidate.start).split("\n");
  const leading: { line: string; lineNumber: number }[] = [];
  // Skip the partial code line the candidate starts on; only comment or blank
  // lines above it can be the candidate's leading comment block.
  for (let index = preceding.length - 2; index >= 0 && leading.length < 8; index -= 1) {
    const line = preceding[index] ?? "";
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (
      trimmed.startsWith("//") || trimmed.startsWith("*")
      || trimmed.startsWith("/*") || trimmed.endsWith("*/")
    ) {
      leading.unshift({ line, lineNumber: index + 1 });
    } else break;
  }
  for (const { line, lineNumber } of leading) scanLine(line, lineNumber);
  const lines = candidateText.split("\n");
  for (const [index, line] of lines.entries()) {
    scanLine(line, candidate.startLine + index);
  }
  if (markers.length === 0) return undefined;

  const literalConditions: string[] = [];
  let emptyBlocks = 0;
  new Visitor({
    IfStatement(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (node.test.type === "Literal") {
        literalConditions.push(owner.source.slice(node.test.start, node.test.end));
      }
    },
    ConditionalExpression(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (node.test.type === "Literal") {
        literalConditions.push(owner.source.slice(node.test.start, node.test.end));
      }
    },
    BlockStatement(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (node.body.length === 0) emptyBlocks += 1;
    },
  }).visit(parsed.program);

  const siblings: PrototypeSibling[] = [];
  new Visitor({
    FunctionDeclaration(node) {
      if (node.start === fn.start && node.end === fn.end) return;
      if (node.start < candidate.start && node.end > candidate.end) return;
      if (!node.id?.name || node.id.name === name) return;
      siblings.push({
        name: node.id.name,
        exported: isFunctionExported(parsed.program, node, node.id.name),
      });
    },
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || node.id.name === name) return;
      if (
        node.init?.type !== "ArrowFunctionExpression"
        && node.init?.type !== "FunctionExpression"
      ) return;
      if (node.start < candidate.start && node.end > candidate.end) return;
      siblings.push({ name: node.id.name, exported: false });
    },
  }).visit(parsed.program);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    markers: markers.slice(0, 10),
    provisional: {
      literalConditions: literalConditions.slice(0, 8),
      emptyBlocks,
    },
    repository: {
      callers: findFunctionCallers(owner.filePath, name, projectFiles),
      siblings: siblings.slice(0, 20),
    },
  };
}
