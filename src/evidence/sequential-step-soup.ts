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

export type StepPhase = {
  index: number;
  line: number;
  statementCount: number;
  declared: string[];
  coherent: boolean;
  preview: string;
};

export type SequentialStepSoupEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  phases: StepPhase[];
  sharedBindings: string[];
  helperAlreadyExtracted: string | null;
  callers: FunctionCaller[];
};

const KEYWORDS = new Set([
  "await", "break", "case", "catch", "const", "continue", "default", "delete", "do",
  "else", "export", "extends", "false", "finally", "for", "function", "if", "import",
  "in", "instanceof", "let", "new", "null", "of", "return", "static", "switch",
  "this", "throw", "true", "try", "typeof", "undefined", "var", "void", "while",
  "with", "yield", "as", "from", "get", "set", "async", "satisfies", "keyof",
  "interface", "type", "enum", "namespace", "declare", "abstract", "implements",
]);

const GLOBALS = new Set([
  "console", "process", "require", "module", "exports", "__dirname", "__filename",
  "JSON", "Object", "Array", "String", "Number", "Boolean", "Math", "Date",
  "RegExp", "Error", "Map", "Set", "Promise", "Symbol", "parseInt", "parseFloat",
  "isNaN", "Number", "String", "Boolean", "Array", "Object", "JSON", "Math",
]);

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function paramNames(fn: FunctionNode, source: string): string[] {
  const names: string[] = [];
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    const text = source.slice(value.start, value.end);
    for (const match of text.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
      const name = match[1];
      if (name && !KEYWORDS.has(name)) names.push(name);
    }
  }
  return [...new Set(names)];
}

function declaredInStatement(source: string, start: number, end: number, statementType: string): string[] {
  const text = source.slice(start, end);
  const names: string[] = [];
  if (statementType === "VariableDeclaration") {
    const keyword = /^(?:const|let|var)\s+/.exec(text)?.[0].length ?? 0;
    const head = text.slice(keyword).split("=")[0] ?? "";
    for (const match of head.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
      const name = match[1];
      if (name && !KEYWORDS.has(name)) names.push(name);
    }
  } else if (statementType === "FunctionDeclaration" || statementType === "ClassDeclaration") {
    const match = /^(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/.exec(text);
    if (match?.[1]) names.push(match[1]);
  }
  return names;
}

function readsIn(source: string): Set<string> {
  const scrubbed = source
    .replace(/\.\s*[A-Za-z_$][\w$]*/g, "")
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "")
    .replace(/\/\/[^\n]*/g, "");
  const reads = new Set<string>();
  for (const match of scrubbed.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
    const name = match[1];
    if (name && !KEYWORDS.has(name) && !GLOBALS.has(name)) reads.add(name);
  }
  return reads;
}

function phaseIsCoherent(source: string): boolean {
  return /[A-Za-z_$][\w$]*\s*\(|\b(for|while|await|return)\b/.test(source);
}

function siblingFunctionNames(
  program: import("oxc-parser").Program,
  ownerSource: string,
  selfStart: number,
  selfEnd: number,
): { name: string; body: string }[] {
  const siblings: { name: string; body: string }[] = [];
  new Visitor({
    FunctionDeclaration: (node) => {
      if (node.start === selfStart && node.end === selfEnd) return;
      if (node.id?.name) siblings.push({ name: node.id.name, body: ownerSource.slice(node.start, node.end) });
    },
    VariableDeclarator: (node) => {
      if (
        node.id.type === "Identifier"
        && (node.init?.type === "ArrowFunctionExpression" || node.init?.type === "FunctionExpression")
      ) {
        if (node.init.start === selfStart && node.init.end === selfEnd) return;
        siblings.push({ name: node.id.name, body: ownerSource.slice(node.init.start, node.init.end) });
      }
    },
  }).visit(program);
  return siblings;
}

export function buildSequentialStepSoupEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): SequentialStepSoupEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  if (!fn.body || fn.body.type !== "BlockStatement") return undefined;

  const statements = fn.body.body;
  if (statements.length < 3) return undefined;

  const groups: { start: number; end: number; type: string }[][] = [[]];
  let previous: { start: number; end: number; type: string } | undefined;
  for (const statement of statements) {
    const current = { start: statement.start, end: statement.end, type: statement.type };
    if (previous) {
      const gap = owner.source.slice(previous.end, current.start);
      if (/\n\s*\n/.test(gap) || /\/\/[^\n]*/.test(gap)) {
        groups.push([]);
      }
    }
    groups[groups.length - 1]?.push(current);
    previous = current;
  }
  if (groups.length < 3) return undefined;

  const params = new Set(paramNames(fn, owner.source));
  const phases: StepPhase[] = groups.map((group, index) => {
    const start = group[0]?.start ?? 0;
    const end = group[group.length - 1]?.end ?? 0;
    const text = owner.source.slice(start, end);
    const declared = group.flatMap((statement) =>
      declaredInStatement(owner.source, statement.start, statement.end, statement.type)
    );
    return {
      index,
      line: lineAt(owner.source, start),
      statementCount: group.length,
      declared,
      coherent: phaseIsCoherent(text),
      preview: text.slice(0, 300),
    };
  });
  if (!phases.every((phase) => phase.coherent)) return undefined;

  const declaredSoFar = new Set<string>();
  const shared = new Set<string>();
  for (const phase of phases) {
    const group = groups[phase.index] ?? [];
    const text = owner.source.slice(
      group[0]?.start ?? 0,
      group[group.length - 1]?.end ?? 0,
    );
    const reads = readsIn(text);
    for (const read of reads) {
      if (declaredSoFar.has(read)) shared.add(read);
    }
    for (const declared of phase.declared) {
      if (!params.has(declared)) declaredSoFar.add(declared);
    }
  }

  let helperAlreadyExtracted: string | null = null;
  const siblings = siblingFunctionNames(parsed.program, owner.source, fn.start, fn.end);
  for (const phase of phases) {
    for (const sibling of siblings) {
      if (new RegExp(`\\b${sibling.name}\\s*\\(`).test(phase.preview)) {
        helperAlreadyExtracted = sibling.name;
        break;
      }
    }
    if (helperAlreadyExtracted) break;
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    phases,
    sharedBindings: [...shared],
    helperAlreadyExtracted,
    callers: findFunctionCallers(owner.filePath, name, projectFiles),
  };
}
