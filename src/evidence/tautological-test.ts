import { Visitor } from "oxc-parser";
import type { CallExpression, Expression, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  calleeRootName,
  isInsideNestedFunction,
  nestedFunctionRanges,
} from "./repository.js";
import { parseTestFunction } from "./test-scope.js";

export type OracleVerdict =
  | "same-computation"
  | "constant-self"
  | "snapshot-without-oracle"
  | "independent-oracle"
  | "unresolved";

export type TautologicalAssertion = {
  assertion: string;
  matcher: string;
  actual: string;
  expected: string | null;
  oracle: OracleVerdict;
  sharedIdentifiers: string[];
};

export type TautologicalTestEvidence = {
  function: {
    title: string | null;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  assertions: TautologicalAssertion[];
  /** Assertion texts whose expected value is recomputed, self-compared, or snapshotted with no independent oracle. */
  tautological: string[];
  /** Outcome assertions whose expected value is a literal worked example independent of the subject computation. */
  companionOracleCount: number;
};

// Test candidacy is filename-based via isTestFilePath inside parseTestFunction
// (*.test.* / *.spec.* segments, __tests__/ dirs): no content signal exists on
// main, so a helper in a test-named file with it/test holders still counts.
const INTERACTION_PATTERN = /\btoHaveBeenCalled|\btoHaveBeenNthCalled|\btoHaveBeenCalledTimes|\btoHaveBeenCalledWith|\btoHaveBeenLastCalledWith|\btoHaveBeenFirstCalledWith|\bcalledOnce\b|\bcalledTwice\b|\bcalledThrice\b|\bcalledWith\b|\bsinon\s*\.\s*assert\b/;

// Throw matchers pin control flow (the throw itself is the oracle), not a
// recomputed value, so they belong to behavioral pinning, not tautology.
const THROW_PATTERN = /\btoThrow|\btoReject\b|\brejects\b/;

// Inline snapshots carrying an explicit literal, and property matchers with
// arguments, state an independent oracle; only zero-arg snapshots freeze own
// output with no oracle to check against.
const SNAPSHOT_PATTERN = /\btoMatchSnapshot\b|\btoMatchInlineSnapshot\b/;

const ASSERTION_ROOTS = new Set(["expect", "assert", "chai"]);

function callText(call: CallExpression, source: string): string {
  return source.slice(call.start, call.end);
}

function propertyName(call: CallExpression): string | null {
  const callee = call.callee.type === "ChainExpression" ? call.callee.expression : call.callee;
  if (callee.type === "MemberExpression" && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  return null;
}

function isAssertionCall(call: CallExpression): boolean {
  const root = calleeRootName(call.callee);
  if (root && ASSERTION_ROOTS.has(root)) return true;
  const property = propertyName(call);
  return property !== null && /^to[A-Z]/.test(property);
}

function unwrap(expression: Expression): Expression {
  return expression.type === "ChainExpression" ? expression.expression : expression;
}

/** Walk `expect(actual)...matcher` chains (including `.not`/`.resolves` links) down to the expect call. */
function expectActual(callee: CallExpression["callee"]): Expression | null {
  const node = callee.type === "ChainExpression" ? callee.expression : callee;
  if (node.type === "CallExpression") {
    if (calleeRootName(node.callee) === "expect") {
      const first = node.arguments[0];
      if (!first || first.type === "SpreadElement") return null;
      return unwrap(first);
    }
    return expectActual(node.callee);
  }
  if (node.type === "MemberExpression") {
    const object = node.object;
    if (
      object.type === "CallExpression"
      || object.type === "MemberExpression"
      || object.type === "ChainExpression"
      || object.type === "Identifier"
    ) return expectActual(object);
    return null;
  }
  return null;
}

function firstArgument(call: CallExpression): Expression | null {
  const first = call.arguments[0];
  if (!first || first.type === "SpreadElement") return null;
  return unwrap(first);
}

function secondArgument(call: CallExpression): Expression | null {
  const second = call.arguments[1];
  if (!second || second.type === "SpreadElement") return null;
  return unwrap(second);
}

function normalize(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

function isLiteralOracle(node: Expression): boolean {
  if (node.type === "Literal") return true;
  if (node.type === "TemplateLiteral" && node.expressions.length === 0) return true;
  if (
    (node.type === "UnaryExpression" || node.type === "UpdateExpression")
    && node.argument.type === "Literal"
  ) return true;
  return false;
}

function isComputedExpectation(node: Expression): boolean {
  return node.type === "CallExpression"
    || node.type === "BinaryExpression"
    || node.type === "LogicalExpression"
    || node.type === "ConditionalExpression"
    || node.type === "AwaitExpression"
    || node.type === "ArrayExpression"
    || node.type === "ObjectExpression"
    || node.type === "NewExpression"
    || (node.type === "TemplateLiteral" && node.expressions.length > 0)
    || node.type === "UpdateExpression"
    || node.type === "UnaryExpression";
}

// Property names of member access ride along inside the shared-identifier
// set; the computed-expectation requirement keeps the verdict honest, since
// a bare shared property alone classifies as unresolved, never tautological.
function identifiersIn(program: Program, root: Expression): string[] {
  const names: string[] = [];
  new Visitor({
    Identifier(identifier) {
      if (identifier.start < root.start || identifier.end > root.end) return;
      if (!names.includes(identifier.name)) names.push(identifier.name);
    },
  }).visit(program);
  return names;
}

type ParsedAssertion = {
  call: CallExpression;
  matcher: string;
  actual: Expression | null;
  expected: Expression | null;
  snapshot: boolean;
};

function parseAssertion(call: CallExpression): ParsedAssertion | undefined {
  const root = calleeRootName(call.callee);
  const property = propertyName(call);
  if (root === "expect" && property) {
    return {
      call,
      matcher: property,
      actual: expectActual(call.callee),
      expected: firstArgument(call),
      snapshot: SNAPSHOT_PATTERN.test(property),
    };
  }
  if (root === "assert" || root === "chai") {
    const method = property ?? "assert";
    if (method === "strictEqual" || method === "deepStrictEqual" || method === "equal" || method === "deepEqual") {
      return {
        call,
        matcher: method,
        actual: firstArgument(call),
        expected: secondArgument(call),
        snapshot: false,
      };
    }
    if (method === "matchSnapshot" || method === "snapshot") {
      return {
        call,
        matcher: method,
        actual: firstArgument(call),
        expected: null,
        snapshot: true,
      };
    }
    // Bare assert(value) / assert.ok(value): a literal states nothing to
    // check; a computed value pins truthiness of the subject outcome.
    return {
      call,
      matcher: method,
      actual: firstArgument(call),
      expected: null,
      snapshot: false,
    };
  }
  if (property && /^to[A-Z]/.test(property)) {
    return {
      call,
      matcher: property,
      actual: null,
      expected: firstArgument(call),
      snapshot: SNAPSHOT_PATTERN.test(property),
    };
  }
  return undefined;
}

function classify(
  parsed: ParsedAssertion,
  program: Program,
  source: string,
): { oracle: OracleVerdict; actual: string; expected: string | null; shared: string[] } | undefined {
  const text = callText(parsed.call, source);
  if (INTERACTION_PATTERN.test(text)) return undefined;
  if (THROW_PATTERN.test(parsed.matcher)) return undefined;

  // Only structural expression nodes are examined: comments, string
  // contents, and type positions never appear as CallExpression arguments,
  // so they cannot produce a finding by construction.
  if (parsed.snapshot) {
    const hasInlineOracle = parsed.expected !== null;
    const actual = parsed.actual ? normalize(source.slice(parsed.actual.start, parsed.actual.end)) : "";
    if (hasInlineOracle || actual === "") return undefined;
    return { oracle: "snapshot-without-oracle", actual, expected: null, shared: [] };
  }

  if (!parsed.actual || !parsed.expected) {
    // Bare assert(value): a literal expected of nothing passes by
    // construction; a computed value pins real truthiness.
    if (parsed.matcher === "assert" || parsed.matcher === "ok") {
      if (!parsed.actual) return undefined;
      const actual = normalize(source.slice(parsed.actual.start, parsed.actual.end));
      if (isLiteralOracle(parsed.actual)) {
        return { oracle: "constant-self", actual, expected: actual, shared: [] };
      }
      return { oracle: "independent-oracle", actual, expected: null, shared: [] };
    }
    return undefined;
  }

  const actual = normalize(source.slice(parsed.actual.start, parsed.actual.end));
  const expected = normalize(source.slice(parsed.expected.start, parsed.expected.end));
  if (actual === "" || expected === "") return undefined;
  if (actual === expected) return { oracle: "constant-self", actual, expected, shared: identifiersIn(program, parsed.actual) };
  if (isLiteralOracle(parsed.expected)) {
    return { oracle: "independent-oracle", actual, expected, shared: [] };
  }
  const actualIds = new Set(identifiersIn(program, parsed.actual));
  const shared = identifiersIn(program, parsed.expected).filter((name) => actualIds.has(name));
  if (shared.length > 0 && isComputedExpectation(parsed.expected)) {
    return { oracle: "same-computation", actual, expected, shared: shared.slice(0, 10) };
  }
  return { oracle: "unresolved", actual, expected, shared: shared.slice(0, 10) };
}

export function buildTautologicalTestEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): TautologicalTestEvidence | undefined {
  const scope = parseTestFunction(candidate, projectFiles);
  if (!scope) return undefined;
  if (scope.runner !== "it" && scope.runner !== "test") return undefined;
  const { owner, program, fn } = scope;
  const nested = nestedFunctionRanges(program, candidate);

  const assertionCalls: CallExpression[] = [];
  new Visitor({
    CallExpression(call) {
      if (call.start < fn.start || call.end > fn.end) return;
      if (isInsideNestedFunction(call, nested)) return;
      if (!isAssertionCall(call)) return;
      assertionCalls.push(call);
    },
  }).visit(program);
  if (assertionCalls.length === 0) return undefined;
  const outermost = assertionCalls.filter((item) =>
    !assertionCalls.some((other) =>
      other !== item && other.start <= item.start && other.end >= item.end
      && (other.start < item.start || other.end > item.end)
    )
  );

  const assertions: TautologicalAssertion[] = [];
  for (const call of outermost) {
    const parsed = parseAssertion(call);
    if (!parsed) continue;
    const result = classify(parsed, program, owner.source);
    if (!result) continue;
    assertions.push({
      assertion: callText(call, owner.source).slice(0, 500),
      matcher: parsed.matcher,
      actual: result.actual.slice(0, 300),
      expected: result.expected?.slice(0, 300) ?? null,
      oracle: result.oracle,
      sharedIdentifiers: result.shared,
    });
  }
  // No outcome comparison to judge: assertion-free tests belong to
  // jev/no-assertion-free-test and interaction pins to interaction pinning.
  if (assertions.length === 0) return undefined;

  const tautological = assertions
    .filter(({ oracle }) =>
      oracle === "same-computation" || oracle === "constant-self" || oracle === "snapshot-without-oracle"
    )
    .map(({ assertion }) => assertion)
    .slice(0, 10);

  return {
    function: {
      title: scope.title,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    assertions: assertions.slice(0, 15),
    tautological,
    companionOracleCount: assertions.filter(({ oracle }) => oracle === "independent-oracle").length,
  };
}
