import { Visitor } from "oxc-parser";
import type { Expression } from "oxc-parser";
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
import { isTestFilePath } from "./test-scope.js";

export type SteeringLiteral = {
  expression: string;
  value: string;
  kind: "number" | "string";
  position: "comparison" | "arithmetic" | "equality";
  binding: string | null;
  line: number;
};

export type LiteralCoSite = {
  expression: string;
  line: number;
};

export type LiteralCoupling = {
  value: string;
  sites: LiteralCoSite[];
};

export type UnexplainedBehavioralLiteralEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  literals: SteeringLiteral[];
  couplings: LiteralCoupling[];
  namedConstants: string[];
  callers: FunctionCaller[];
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

const COMPARISON_OPERATORS = new Set([">", "<", ">=", "<="]);
const EQUALITY_OPERATORS = new Set(["===", "!==", "==", "!="]);
const ARITHMETIC_OPERATORS = new Set(["+", "-", "*", "/", "%", "**"]);

// Idiom allowlist (structural abstention, never scored). Conservative by
// design; each rule is enumerated here:
//   1. zero-equality: a numeric 0 in ===/!==/==/!= position (emptiness check).
//   2. length-emptiness: a *.length access compared (equality or comparison)
//      against 0 or 1 (.length === 0, .length > 0, .length >= 1, ...).
//   3. typeof-guard: a typeof ... expression in equality position.
//   4. closed-set-flag: a string literal in equality position whose binding is
//      equality-compared against two or more distinct string values in the
//      same function (discriminated-union / flag checks over an obvious set).
const LENGTH_ACCESS = new Set(["length"]);
const COUPLING_SLICE_METHODS = new Set(["slice", "substring"]);
// Canonical 0/1 never couple: identity-ish values whose recurrence across
// sites is coincidence, not a must-agree seam.
const COUPLING_EXCLUDED = new Set(["0", "1"]);

function literalKind(raw: string | null): "number" | "string" | null {
  if (raw === null) return null;
  if (raw.startsWith('"') || raw.startsWith("'")) return "string";
  if (/^-?\d/.test(raw) || /^\.\d/.test(raw)) return "number";
  return null;
}

function canonicalNumber(raw: string): string | null {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return null;
  return String(parsed);
}

function isLengthAccess(expression: Expression): boolean {
  return expression.type === "MemberExpression"
    && !expression.computed
    && expression.property.type === "Identifier"
    && LENGTH_ACCESS.has(expression.property.name);
}

function isTypeofGuard(expression: Expression): boolean {
  return expression.type === "UnaryExpression" && expression.operator === "typeof";
}

function otherBinding(other: Expression): string | null {
  return other.type === "Identifier" ? other.name : null;
}

type LiteralRecord = {
  start: number;
  end: number;
  value: string;
  kind: "number" | "string";
  position: SteeringLiteral["position"];
  binding: string | null;
  otherIsLength: boolean;
  otherIsTypeof: boolean;
};

function isIdiom(record: LiteralRecord, closedSetBindings: Set<string>): boolean {
  if (record.kind === "number") {
    const canon = canonicalNumber(record.value);
    if (record.position === "equality" && canon === "0") return true;
    if (record.otherIsLength && (canon === "0" || canon === "1")) return true;
    return false;
  }
  if (record.kind === "string" && record.position === "equality") {
    if (record.otherIsTypeof) return true;
    if (record.binding !== null && closedSetBindings.has(record.binding)) return true;
  }
  return false;
}

export function buildUnexplainedBehavioralLiteralEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnexplainedBehavioralLiteralEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  if (isTestFilePath(candidate.filePath)) return undefined;
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

  const namedConstants: string[] = [];
  new Visitor({
    VariableDeclarator(node) {
      if (!direct(node) || node.id.type !== "Identifier" || !node.init) return;
      if (node.init.type === "Literal" || node.init.type === "TemplateLiteral") {
        if (!namedConstants.includes(node.id.name)) namedConstants.push(node.id.name);
      }
    },
  }).visit(parsed.program);

  const records: LiteralRecord[] = [];
  new Visitor({
    BinaryExpression(node) {
      if (!direct(node)) return;
      const left = node.left.type === "Literal" ? node.left : null;
      const right = node.right.type === "Literal" ? node.right : null;
      const literal = left ?? right;
      const kind = literalKind(literal?.raw ?? null);
      if (!literal || !kind) return;
      const value = literal.raw ?? "";
      const other = literal === left ? node.right : node.left;
      if (COMPARISON_OPERATORS.has(node.operator)) {
        records.push({
          start: node.start,
          end: node.end,
          value,
          kind,
          position: "comparison",
          binding: otherBinding(other),
          otherIsLength: isLengthAccess(other),
          otherIsTypeof: isTypeofGuard(other),
        });
      } else if (EQUALITY_OPERATORS.has(node.operator)) {
        records.push({
          start: node.start,
          end: node.end,
          value,
          kind,
          position: "equality",
          binding: otherBinding(other),
          otherIsLength: isLengthAccess(other),
          otherIsTypeof: isTypeofGuard(other),
        });
      } else if (ARITHMETIC_OPERATORS.has(node.operator)) {
        if (other.type !== "Literal") {
          records.push({
            start: node.start,
            end: node.end,
            value,
            kind,
            position: "arithmetic",
            binding: otherBinding(other),
            otherIsLength: isLengthAccess(other),
            otherIsTypeof: false,
          });
        }
      }
    },
  }).visit(parsed.program);

  // Closed-set signal: bindings equality-compared against two or more
  // distinct string values show the code discriminating over an obvious set.
  const stringsByBinding = new Map<string, Set<string>>();
  for (const record of records) {
    if (record.kind !== "string" || record.position !== "equality" || record.binding === null) {
      continue;
    }
    if (record.otherIsTypeof) continue;
    let values = stringsByBinding.get(record.binding);
    if (!values) {
      values = new Set();
      stringsByBinding.set(record.binding, values);
    }
    values.add(record.value);
  }
  const closedSetBindings = new Set<string>();
  for (const [binding, values] of stringsByBinding) {
    if (values.size >= 2) closedSetBindings.add(binding);
  }

  const literals: SteeringLiteral[] = [];
  const couplingSites: { canon: string; expression: string; line: number }[] = [];
  const seenLiteral = new Set<string>();
  for (const record of records) {
    if (isIdiom(record, closedSetBindings)) continue;
    const expression = owner.source.slice(record.start, record.end).slice(0, 200);
    const line = lineAt(owner.source, record.start);
    const key = `${line}:${expression}`;
    if (seenLiteral.has(key)) continue;
    seenLiteral.add(key);
    literals.push({
      expression,
      value: record.value.slice(0, 100),
      kind: record.kind,
      position: record.position,
      binding: record.binding,
      line,
    });
    if (record.kind === "number") {
      const canon = canonicalNumber(record.value);
      if (canon !== null && !COUPLING_EXCLUDED.has(canon)) {
        couplingSites.push({ canon, expression, line });
      }
    }
  }

  // Derived forms (N / length-N / slice(0,N)) all spell the same numeric
  // value, so numeric args of slice/substring calls join the coupling sites.
  const seenSite = new Set(couplingSites.map((site) => `${site.line}:${site.expression}`));
  new Visitor({
    CallExpression(node) {
      if (!direct(node)) return;
      if (node.callee.type !== "MemberExpression" || node.callee.computed) return;
      if (node.callee.property.type !== "Identifier") return;
      if (!COUPLING_SLICE_METHODS.has(node.callee.property.name)) return;
      const callText = owner.source.slice(node.start, node.end).slice(0, 200);
      for (const argument of node.arguments) {
        if (argument.type === "SpreadElement") continue;
        if (argument.type !== "Literal" || literalKind(argument.raw ?? null) !== "number") continue;
        const canon = canonicalNumber(argument.raw ?? "");
        if (canon === null || COUPLING_EXCLUDED.has(canon)) continue;
        const line = lineAt(owner.source, argument.start ?? node.start);
        const key = `${line}:${callText}`;
        if (seenSite.has(key)) continue;
        seenSite.add(key);
        couplingSites.push({ canon, expression: callText, line });
      }
    },
  }).visit(parsed.program);

  if (literals.length === 0) return undefined;

  const sitesByValue = new Map<string, LiteralCoSite[]>();
  const seenPerValue = new Map<string, Set<string>>();
  for (const site of couplingSites) {
    let group = sitesByValue.get(site.canon);
    if (!group) {
      group = [];
      sitesByValue.set(site.canon, group);
      seenPerValue.set(site.canon, new Set());
    }
    const seen = seenPerValue.get(site.canon);
    const key = `${site.line}:${site.expression}`;
    if (seen?.has(key)) continue;
    seen?.add(key);
    group.push({ expression: site.expression, line: site.line });
  }
  const couplings: LiteralCoupling[] = [];
  for (const [value, sites] of sitesByValue) {
    if (sites.length >= 2) couplings.push({ value, sites });
  }
  couplings.sort((left, right) => left.value.localeCompare(right.value));

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    literals: literals.slice(0, 20),
    couplings: couplings.slice(0, 10),
    namedConstants: namedConstants.slice(0, 10),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
