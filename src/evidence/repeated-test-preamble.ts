import { Visitor } from "oxc-parser";
import type { CallExpression, Node, Program, Statement } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { calleeRootName } from "./repository.js";
import { parseTestFunction } from "./test-scope.js";
import type { FunctionNode } from "./repository.js";

export type PreambleRepetition = {
  sibling: string;
  fingerprint: string;
};

export type SharedFactory = {
  name: string;
  calledByCandidate: boolean;
  calledBySiblings: number;
};

export type RepeatedTestPreambleEvidence = {
  function: {
    title: string | null;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  setup: {
    fingerprint: string;
    statements: string[];
  };
  repetitions: PreambleRepetition[];
  sharedHelpers: {
    beforeEach: boolean;
    factories: SharedFactory[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function normalizeSetup(text: string): string {
  return text
    .replace(/\b[A-Za-z_$][\w$]*\b(?=\s*\()/g, "CALL")
    .replace(/\b[A-Za-z_$][\w$]*\b/g, "?")
    .replace(/\s+/g, " ")
    .trim();
}

function isSetupStatement(statement: Statement): boolean {
  return statement.type === "VariableDeclaration" || statement.type === "ExpressionStatement";
}

function leadingSetup(
  fn: FunctionNode,
  source: string,
): { fingerprint: string; texts: string[] } | undefined {
  if (!fn.body || fn.body.type !== "BlockStatement") return undefined;
  const leading = fn.body.body.filter(isSetupStatement).slice(0, 5);
  if (leading.length === 0) return undefined;
  const texts = leading.map((statement) => nodeSource(statement, source));
  return { fingerprint: texts.map(normalizeSetup).join(" || "), texts };
}

function testCallbacks(
  program: Program,
  source: string,
): { title: string; fn: FunctionNode }[] {
  const result: { title: string; fn: FunctionNode }[] = [];
  new Visitor({
    CallExpression(call: CallExpression) {
      const root = calleeRootName(call.callee);
      if (root !== "it" && root !== "test") return;
      const callback = call.arguments.find((argument): argument is FunctionNode =>
        argument.type === "ArrowFunctionExpression" || argument.type === "FunctionExpression"
      );
      if (!callback) return;
      const first = call.arguments[0];
      const title = first && first.type !== "SpreadElement" && first.type === "Literal"
        ? source.slice(first.start, first.end).slice(1, -1)
        : "";
      result.push({ title, fn: callback });
    },
  }).visit(program);
  return result;
}

function topLevelFactories(
  program: Program,
): string[] {
  const names: string[] = [];
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (declaration?.type === "FunctionDeclaration" && declaration.id?.name) {
      if (/^(make|create|build|setup|mock|stub|fake)/i.test(declaration.id.name)) {
        names.push(declaration.id.name);
      }
    }
    if (declaration?.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (
          item.id.type === "Identifier"
          && (item.init?.type === "ArrowFunctionExpression" || item.init?.type === "FunctionExpression")
          && /^(make|create|build|setup|mock|stub|fake)/i.test(item.id.name)
        ) names.push(item.id.name);
      }
    }
  }
  return names;
}

export function buildRepeatedTestPreambleEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): RepeatedTestPreambleEvidence | undefined {
  const scope = parseTestFunction(candidate, projectFiles);
  if (!scope) return undefined;
  if (scope.runner !== "it" && scope.runner !== "test") return undefined;
  const { owner, program, fn } = scope;

  const setup = leadingSetup(fn, owner.source);
  if (!setup) return undefined;

  const siblings = testCallbacks(program, owner.source);
  const repetitions: PreambleRepetition[] = [];
  for (const sibling of siblings) {
    if (sibling.fn.start === fn.start && sibling.fn.end === fn.end) continue;
    const siblingSetup = leadingSetup(sibling.fn, owner.source);
    if (!siblingSetup || siblingSetup.fingerprint !== setup.fingerprint) continue;
    repetitions.push({ sibling: sibling.title, fingerprint: siblingSetup.fingerprint });
  }

  let beforeEach = false;
  new Visitor({
    CallExpression(call: CallExpression) {
      if (calleeRootName(call.callee) === "beforeEach") beforeEach = true;
    },
  }).visit(program);

  const factories = topLevelFactories(program);
  const calledNames = (target: FunctionNode): Set<string> => {
    const names = new Set<string>();
    new Visitor({
      CallExpression(call: CallExpression) {
        if (call.start < target.start || call.end > target.end) return;
        const root = calleeRootName(call.callee);
        if (root) names.add(root);
      },
    }).visit(program);
    return names;
  };
  const candidateCalls = calledNames(fn);
  const sharedFactories: SharedFactory[] = factories.map((name) => ({
    name,
    calledByCandidate: candidateCalls.has(name),
    calledBySiblings: siblings.filter(({ fn: siblingFn }) =>
      siblingFn !== fn && calledNames(siblingFn).has(name)
    ).length,
  }));

  return {
    function: {
      title: scope.title,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    setup: {
      fingerprint: setup.fingerprint,
      statements: setup.texts.map((text) => text.slice(0, 300)),
    },
    repetitions: repetitions.slice(0, 10),
    sharedHelpers: {
      beforeEach,
      factories: sharedFactories.slice(0, 10),
    },
  };
}
