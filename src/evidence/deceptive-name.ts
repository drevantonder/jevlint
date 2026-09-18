import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type DeceptiveFinding = {
  name: string;
  kind: "parameter" | "local";
  asserted: string;
  observed: string;
  source: string;
};

export type DeceptiveNameReuse = {
  name: string;
  filePath: string;
  source: string;
};

export type DeceptiveNameEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  findings: DeceptiveFinding[];
  establishingOperations: string[];
  reuses: DeceptiveNameReuse[];
  callers: FunctionCaller[];
};

type Binding = {
  name: string;
  kind: "parameter" | "local";
  annotation: string | null;
  init: Expression | null;
  source: string;
};

const SINGULAR_DENYLIST = new Set([
  "status",
  "news",
  "class",
  "glass",
  "alias",
  "bias",
  "canvas",
  "this",
]);

const CONTAINER_WORDS: Array<{ word: RegExp; asserted: string }> = [
  { word: /list/i, asserted: "list-container" },
  { word: /array/i, asserted: "array-container" },
  { word: /\bmap\b/i, asserted: "map-container" },
  { word: /\bset\b/i, asserted: "set-container" },
  { word: /dict/i, asserted: "dictionary-container" },
  { word: /collection/i, asserted: "collection-container" },
];

const BOOLEAN_PREFIX = /^(is|has|have|can|should|was|were|are|did|will|would)[A-Z]/;

const QUALITY_CLAIMS: Array<{ pattern: RegExp; asserted: string; establishing: RegExp }> = [
  { pattern: /sorted/i, asserted: "sorted", establishing: /\.sort\s*\(/ },
  { pattern: /canonical/i, asserted: "canonical", establishing: /canonical|normali[sz]e/ },
  { pattern: /\bsafe\b/i, asserted: "safe", establishing: /saniti[sz]e|escape|validate|authori[sz]e/ },
  {
    pattern: /validated/i,
    asserted: "validated",
    establishing: /validate|assert|invariant|\bcheck\b|throw/,
  },
  {
    pattern: /normali[sz]ed/i,
    asserted: "normalized",
    establishing: /normali[sz]e|toLowerCase|trim\(\)/,
  },
  { pattern: /unique/i, asserted: "unique", establishing: /\bSet\b|dedupe|distinct/ },
];

function bindingName(parameter: FunctionNode["params"][number]): string | undefined {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
    return value.left.name;
  }
  if (value.type === "RestElement" && value.argument.type === "Identifier") {
    return value.argument.name;
  }
  if (value.type !== "Identifier") return undefined;
  return value.name;
}

function annotationOf(
  parameter: FunctionNode["params"][number],
  source: string,
): string | null {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  const identifier = value.type === "AssignmentPattern" && value.left.type === "Identifier"
    ? value.left
    : value.type === "Identifier"
      ? value
      : null;
  if (!identifier || !identifier.typeAnnotation) return null;
  return source
    .slice(identifier.typeAnnotation.start, identifier.typeAnnotation.end)
    .replace(/^:\s*/, "");
}

function initKind(init: Expression): string {
  if (init.type === "ArrayExpression") return "array";
  if (init.type === "ObjectExpression") return "single object";
  if (init.type === "Literal") {
    if (init.value === true || init.value === false) return "boolean";
    if (Number.isFinite(init.value)) return "single number";
    return "single value";
  }
  if (init.type === "TemplateLiteral") return "single string";
  if (init.type === "NewExpression") {
    const callee = init.callee.type === "Identifier" ? init.callee.name : "expression";
    return `new ${callee}()`;
  }
  return init.type;
}

function isPluralNoun(name: string): boolean {
  if (!name.endsWith("s") || name.length <= 3) return false;
  return !SINGULAR_DENYLIST.has(name.toLowerCase());
}

function annotationIsPlural(annotation: string): boolean {
  return /\[\]|\bArray\b|\bSet\b|\bMap\b|\bRecord\b|,.+=>|^\s*\{[^}]*\}\s*\[\]/.test(annotation);
}

function annotationIsBoolean(annotation: string): boolean {
  return /\bboolean\b/.test(annotation);
}

function isSingularInit(init: Expression): boolean {
  if (init.type === "ArrayExpression") return false;
  if (
    init.type === "NewExpression"
    && init.callee.type === "Identifier"
    && /^(Array|Set|Map)$/.test(init.callee.name)
  ) return false;
  return init.type === "Literal"
    || init.type === "TemplateLiteral"
    || init.type === "ObjectExpression"
    || init.type === "Identifier";
}

function isBooleanLikeInit(init: Expression): boolean {
  if (init.type === "Literal") return init.value === true || init.value === false;
  return init.type === "UnaryExpression"
    || init.type === "BinaryExpression"
    || init.type === "LogicalExpression";
}

function checkBinding(binding: Binding, establishing: Set<string>): DeceptiveFinding[] {
  const findings: DeceptiveFinding[] = [];
  const { name, annotation, init } = binding;
  if (isPluralNoun(name)) {
    if (annotation !== null && !annotationIsPlural(annotation)) {
      findings.push({
        name,
        kind: binding.kind,
        asserted: "plural collection",
        observed: annotation,
        source: binding.source,
      });
    } else if (annotation === null && init !== null && isSingularInit(init)) {
      findings.push({
        name,
        kind: binding.kind,
        asserted: "plural collection",
        observed: initKind(init),
        source: binding.source,
      });
    }
  }
  for (const { word, asserted } of CONTAINER_WORDS) {
    if (!word.test(name)) continue;
    const observedInit = binding.init ? initKind(binding.init) : binding.annotation ?? "unknown";
    const mismatch = binding.init !== null && (
      (asserted === "list-container" || asserted === "array-container")
        ? binding.init.type !== "ArrayExpression"
          && !(binding.init.type === "NewExpression"
            && binding.init.callee.type === "Identifier"
            && binding.init.callee.name === "Array")
        : asserted === "map-container"
          ? !(binding.init.type === "NewExpression"
            && binding.init.callee.type === "Identifier"
            && binding.init.callee.name === "Map") && binding.init.type !== "ObjectExpression"
          : !(binding.init.type === "NewExpression"
            && binding.init.callee.type === "Identifier"
            && binding.init.callee.name === "Set")
    );
    const annotationMismatch = binding.init === null
      && binding.annotation !== null
      && asserted === "list-container"
      && !annotationIsPlural(binding.annotation);
    if (mismatch || annotationMismatch) {
      findings.push({
        name,
        kind: binding.kind,
        asserted,
        observed: observedInit,
        source: binding.source,
      });
    }
  }
  if (BOOLEAN_PREFIX.test(name)) {
    if (annotation !== null && !annotationIsBoolean(annotation)) {
      findings.push({
        name,
        kind: binding.kind,
        asserted: "boolean predicate",
        observed: annotation,
        source: binding.source,
      });
    } else if (annotation === null && init !== null && !isBooleanLikeInit(init)) {
      findings.push({
        name,
        kind: binding.kind,
        asserted: "boolean predicate",
        observed: initKind(init),
        source: binding.source,
      });
    }
  }
  for (const { pattern, asserted, establishing: wanted } of QUALITY_CLAIMS) {
    if (!pattern.test(name)) continue;
    const body = establishing;
    let found = false;
    for (const operation of body) {
      if (wanted.test(operation)) {
        found = true;
        break;
      }
    }
    if (!found) {
      findings.push({
        name,
        kind: binding.kind,
        asserted,
        observed: "no establishing operation in the function body",
        source: binding.source,
      });
    }
  }
  return findings;
}

function collectReuses(
  names: Set<string>,
  ownerPath: string,
  projectFiles: ProjectFile[],
): DeceptiveNameReuse[] {
  const reuses: DeceptiveNameReuse[] = [];
  for (const file of projectFiles) {
    if (file.filePath === ownerPath || reuses.length >= 8) continue;
    const parsed = parseCached(file.filePath, file.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    new Visitor({
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier" || !names.has(node.id.name)) return;
        if (reuses.length >= 8) return;
        reuses.push({
          name: node.id.name,
          filePath: file.filePath,
          source: file.source.slice(node.start, node.end).slice(0, 400),
        });
      },
      FunctionDeclaration(node) {
        if (!node.id || !names.has(node.id.name)) return;
        if (reuses.length >= 8) return;
        reuses.push({
          name: node.id.name,
          filePath: file.filePath,
          source: file.source.slice(node.start, node.end).slice(0, 400),
        });
      },
    }).visit(parsed.program);
  }
  return reuses;
}

export function buildDeceptiveNameEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DeceptiveNameEvidence | undefined {
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

  const bindings: Binding[] = [];
  for (const parameter of fn.params) {
    const paramName = bindingName(parameter);
    if (!paramName) continue;
    bindings.push({
      name: paramName,
      kind: "parameter",
      annotation: annotationOf(parameter, owner.source),
      init: parameter.type === "AssignmentPattern" ? parameter.right : null,
      source: owner.source.slice(parameter.start, parameter.end).slice(0, 300),
    });
  }
  new Visitor({
    VariableDeclarator(node) {
      if (!direct(node) || node.id.type !== "Identifier") return;
      const annotation = node.id.typeAnnotation
        ? owner.source
          .slice(node.id.typeAnnotation.start, node.id.typeAnnotation.end)
          .replace(/^:\s*/, "")
        : null;
      bindings.push({
        name: node.id.name,
        kind: "local",
        annotation,
        init: node.init,
        source: owner.source.slice(node.start, node.end).slice(0, 300),
      });
    },
  }).visit(parsed.program);

  const bodySource = owner.source.slice(candidate.start, candidate.end);
  const establishing = new Set<string>();
  const callPattern = /(\.\s*[A-Za-z_$][\w$]*\s*\()|([A-Za-z_$][\w$]*\s*\()/g;
  let match: RegExpExecArray | null;
  while ((match = callPattern.exec(bodySource)) !== null) {
    establishing.add(match[0]);
  }
  if (/\.sort\s*\(/.test(bodySource)) establishing.add(".sort(");

  const findings = bindings.flatMap((binding) => checkBinding(binding, establishing));
  if (findings.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    findings,
    establishingOperations: [...establishing].slice(0, 20),
    reuses: collectReuses(new Set(findings.map((finding) => finding.name)), owner.filePath, projectFiles),
    callers: findFunctionCallers(owner.filePath, name, projectFiles),
  };
}
