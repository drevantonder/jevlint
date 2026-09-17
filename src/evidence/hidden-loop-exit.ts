import { parseSync, Visitor } from "oxc-parser";
import type {
  BreakStatement,
  ConditionalExpression,
  ContinueStatement,
  DoWhileStatement,
  ForInStatement,
  ForOfStatement,
  ForStatement,
  IfStatement,
  Node,
  ReturnStatement,
  SwitchStatement,
  WhileStatement,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  isInsideNestedFunction,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type LoopExit = {
  kind: "break" | "continue" | "return";
  label: string | null;
  condition: string | null;
  line: number;
  conditional: boolean;
  namedPredicate: boolean;
  duplicatesHeader: boolean;
};

export type LoopEvidence = {
  kind: string;
  header: string;
  line: number;
  bounded: boolean;
  headerCondition: string | null;
  exits: LoopExit[];
};

export type HiddenLoopExitEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  loops: LoopEvidence[];
  callers: FunctionCaller[];
};

type LoopNode = ForStatement | ForInStatement | ForOfStatement | WhileStatement | DoWhileStatement;
type ExitNode = BreakStatement | ContinueStatement | ReturnStatement;
type GuardNode = IfStatement | ConditionalExpression;

type LoopHeader = {
  header: string;
  bounded: boolean;
  condition: string | null;
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function contains(outer: Node, inner: Node): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

function loopTest(loop: LoopNode): Node | undefined {
  if (loop.type === "ForStatement" || loop.type === "WhileStatement" || loop.type === "DoWhileStatement") {
    return loop.test ?? undefined;
  }
  return undefined;
}

function loopBody(loop: LoopNode): Node {
  return loop.body;
}

function headerFacts(source: string, loop: LoopNode): LoopHeader {
  const body = loopBody(loop);
  const header = source.slice(loop.start, body.start).trim();
  if (loop.type === "ForInStatement" || loop.type === "ForOfStatement") {
    return { header, bounded: true, condition: null };
  }
  const test = loopTest(loop);
  if (!test) return { header, bounded: false, condition: null };
  const condition = source.slice(test.start, test.end).trim();
  if (condition === "" || condition === "true") {
    return { header, bounded: false, condition: condition === "" ? null : condition };
  }
  return { header, bounded: true, condition };
}

function isNamedPredicate(condition: string): boolean {
  const trimmed = condition.trim();
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return true;
  if (/^[A-Za-z_$][\w$]*\s*\(.*\)$/.test(trimmed) && !/[=!<>|&?]/.test(trimmed)) return true;
  return false;
}

function normalizeCondition(condition: string): string {
  return condition.replaceAll(/\s+/g, " ").trim();
}

function guardTest(guard: GuardNode): Node {
  return guard.test;
}

function exitLabel(exit: ExitNode): string | null {
  if (exit.type === "ReturnStatement") return null;
  return exit.label?.name ?? null;
}

export function buildHiddenLoopExitEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HiddenLoopExitEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn: FunctionNode | undefined = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const owned = (node: Node): boolean =>
    node.start >= candidate.start
    && node.end <= candidate.end
    && !isInsideNestedFunction(node, nested);

  const loops: LoopNode[] = [];
  const switches: SwitchStatement[] = [];
  const guards: GuardNode[] = [];
  const exits: ExitNode[] = [];
  new Visitor({
    ForStatement: (node) => {
      if (owned(node)) loops.push(node);
    },
    ForInStatement: (node) => {
      if (owned(node)) loops.push(node);
    },
    ForOfStatement: (node) => {
      if (owned(node)) loops.push(node);
    },
    WhileStatement: (node) => {
      if (owned(node)) loops.push(node);
    },
    DoWhileStatement: (node) => {
      if (owned(node)) loops.push(node);
    },
    SwitchStatement: (node) => {
      if (owned(node)) switches.push(node);
    },
    IfStatement: (node) => {
      if (owned(node)) guards.push(node);
    },
    ConditionalExpression: (node) => {
      if (owned(node)) guards.push(node);
    },
    BreakStatement: (node) => {
      if (owned(node)) exits.push(node);
    },
    ContinueStatement: (node) => {
      if (owned(node)) exits.push(node);
    },
    ReturnStatement: (node) => {
      if (owned(node)) exits.push(node);
    },
  }).visit(parsed.program);

  const evidence: LoopEvidence[] = [];
  for (const loop of loops) {
    const facts = headerFacts(owner.source, loop);
    const loopExits: LoopExit[] = [];
    for (const exit of exits) {
      if (!contains(loop, exit)) continue;
      // A break or continue inside a switch case or a nested loop belongs to
      // that construct, not to this loop. A return still exits this loop.
      if (exit.type !== "ReturnStatement") {
        const redirected = [...switches, ...loops].some((container) =>
          container !== loop
          && contains(loop, container)
          && contains(container, exit)
        );
        if (redirected) continue;
      } else if (loops.some((inner) => inner !== loop && contains(loop, inner) && contains(inner, exit))) {
        continue;
      }
      let guard: GuardNode | undefined;
      for (const candidateGuard of guards) {
        if (!contains(loop, candidateGuard) || !contains(candidateGuard, exit)) continue;
        if (contains(guardTest(candidateGuard), exit)) continue;
        if (guard === undefined || contains(guard, candidateGuard)) guard = candidateGuard;
      }
      const condition = guard ? owner.source.slice(guard.test.start, guard.test.end).trim() : null;
      loopExits.push({
        kind: exit.type === "BreakStatement"
          ? "break"
          : exit.type === "ContinueStatement"
            ? "continue"
            : "return",
        label: exitLabel(exit),
        condition,
        line: lineAt(owner.source, exit.start),
        conditional: condition !== null,
        namedPredicate: condition !== null && isNamedPredicate(condition),
        duplicatesHeader: condition !== null
          && facts.condition !== null
          && normalizeCondition(condition) === normalizeCondition(facts.condition),
      });
    }
    if (loopExits.length > 0) {
      evidence.push({
        kind: loop.type,
        header: facts.header,
        line: lineAt(owner.source, loop.start),
        bounded: facts.bounded,
        headerCondition: facts.condition,
        exits: loopExits,
      });
    }
  }

  if (evidence.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    loops: evidence,
    callers: findFunctionCallers(owner.filePath, name, projectFiles),
  };
}
