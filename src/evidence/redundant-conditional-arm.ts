import { parseSync, Visitor } from "oxc-parser";
import type { Expression, Node } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, containsNode } from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type ConditionalArm = {
  source: string;
  test: string | null;
  body: string;
  bodyFingerprint: string;
};

export type ConditionalSite = {
  kind: "if-chain" | "switch";
  source: string;
  discriminant: string | null;
  arms: ConditionalArm[];
  bodyGroups: number[][];
  singleMeaningfulArm: boolean;
};

export type RedundantConditionalArmEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  conditionals: ConditionalSite[];
  opaqueTests: string[];
  repository: {
    callers: FunctionCaller[];
  };
};

function nodeSource(node: Node, source: string): string {
  return source.slice(node.start, node.end);
}

function fingerprint(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function testRootName(test: Expression): string | undefined {
  if (test.type === "Identifier") return test.name;
  if (test.type === "MemberExpression") return testRootName(test.object);
  if (test.type === "ChainExpression") return testRootName(test.expression);
  if (
    test.type === "BinaryExpression"
    || test.type === "LogicalExpression"
  ) {
    const left = test.left.type === "Identifier"
      ? test.left.name
      : test.left.type === "MemberExpression"
        ? testRootName(test.left)
        : undefined;
    if (left !== undefined) return left;
    return test.right.type === "Identifier"
      ? test.right.name
      : test.right.type === "MemberExpression"
        ? testRootName(test.right)
        : undefined;
  }
  if (test.type === "UnaryExpression") return testRootName(test.argument);
  if (test.type === "CallExpression") return undefined;
  return undefined;
}

const CALL_LIKE = /(?<![\w$])[_$A-Za-z][\w$]*\s*\(/;

function testSourceCallsPredicate(testSource: string): boolean {
  return CALL_LIKE.test(testSource);
}

type IfStatementNode = Extract<Node, { type: "IfStatement" }>;

type IfChainLink = {
  test: Expression;
  body: IfStatementNode["consequent"];
  alternate: IfStatementNode["alternate"];
};

type IfChainResult = {
  arms: ConditionalArm[];
  opaque: string[];
};

function collectIfChainArms(
  root: IfStatementNode,
  source: string,
): IfChainResult {
  const arms: ConditionalArm[] = [];
  const opaque: string[] = [];
  let current: IfChainLink | null = {
    test: root.test,
    body: root.consequent,
    alternate: root.alternate,
  };
  while (current) {
    const testText = nodeSource(current.test, source);
    arms.push({
      source: testText,
      test: testText,
      body: nodeSource(current.body, source),
      bodyFingerprint: fingerprint(nodeSource(current.body, source)),
    });
    if (testSourceCallsPredicate(testText)) opaque.push(testText.slice(0, 200));
    const alternate: IfStatementNode["alternate"] = current.alternate;
    if (alternate?.type === "IfStatement") {
      current = { test: alternate.test, body: alternate.consequent, alternate: alternate.alternate };
    } else {
      if (alternate) {
        const bodyText = nodeSource(alternate, source);
        arms.push({
          source: bodyText,
          test: null,
          body: bodyText,
          bodyFingerprint: fingerprint(bodyText),
        });
      }
      current = null;
    }
  }
  return { arms, opaque };
}

function bodyGroups(arms: ConditionalArm[]): number[][] {
  const groups = new Map<string, number[]>();
  arms.forEach((arm, index) => {
    const existing = groups.get(arm.bodyFingerprint) ?? [];
    existing.push(index);
    groups.set(arm.bodyFingerprint, existing);
  });
  return [...groups.values()].filter((group) => group.length > 1);
}

function vacuousBody(body: string): boolean {
  const compact = fingerprint(body).replace(/^[{\s]+|[}\s;]+$/g, "").trim();
  return compact === "" || compact === "break";
}

export function buildRedundantConditionalArmEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): RedundantConditionalArmEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseSync(ownerFile.filePath, ownerFile.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn: FunctionNode | undefined = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const nested: NodeRange[] = [];
  new Visitor({
    ArrowFunctionExpression(node) {
      if (node !== fn && containsNode(fn, node)) nested.push(node);
    },
    FunctionDeclaration(node) {
      if (node !== fn && containsNode(fn, node)) nested.push(node);
    },
    FunctionExpression(node) {
      if (node !== fn && containsNode(fn, node)) nested.push(node);
    },
  }).visit(parsed.program);

  const elseIfNodes = new Set<Node>();
  new Visitor({
    IfStatement(node) {
      if (node.alternate?.type === "IfStatement") elseIfNodes.add(node.alternate);
    },
  }).visit(parsed.program);

  const conditionals: ConditionalSite[] = [];
  const opaqueTests: string[] = [];
  new Visitor({
    IfStatement(node) {
      if (elseIfNodes.has(node)) return;
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      if (!node.alternate) return;
      const { arms, opaque } = collectIfChainArms(node, ownerFile.source);
      const discriminant = testRootName(node.test) ?? null;
      const meaningful = arms.filter((arm) => !vacuousBody(arm.body));
      conditionals.push({
        kind: "if-chain",
        source: nodeSource(node, ownerFile.source).slice(0, 2000),
        discriminant,
        arms: arms.map((arm) => ({
          ...arm,
          source: arm.source.slice(0, 500),
          body: arm.body.slice(0, 500),
        })),
        bodyGroups: bodyGroups(arms),
        singleMeaningfulArm: meaningful.length < 2,
      });
      opaqueTests.push(...opaque);
    },
    SwitchStatement(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const discriminant = node.discriminant.type === "Identifier" ? node.discriminant.name : null;
      const arms: ConditionalArm[] = node.cases.map((item) => {
        const bodyText = item.consequent.map((statement) => nodeSource(statement, ownerFile.source)).join("\n");
        return {
          source: item.test ? nodeSource(item.test, ownerFile.source) : "default",
          test: item.test ? nodeSource(item.test, ownerFile.source) : null,
          body: bodyText,
          bodyFingerprint: fingerprint(bodyText),
        };
      });
      const meaningful = arms.filter((arm) => !vacuousBody(arm.body));
      conditionals.push({
        kind: "switch",
        source: nodeSource(node, ownerFile.source).slice(0, 2000),
        discriminant,
        arms: arms.map((arm) => ({
          ...arm,
          source: arm.source.slice(0, 500),
          body: arm.body.slice(0, 500),
        })),
        bodyGroups: bodyGroups(arms),
        singleMeaningfulArm: meaningful.length < 2,
      });
    },
  }).visit(parsed.program);

  if (conditionals.length === 0) return undefined;

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    conditionals,
    opaqueTests: [...new Set(opaqueTests)].slice(0, 10),
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
    },
  };
}
