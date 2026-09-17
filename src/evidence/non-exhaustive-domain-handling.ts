import { parseSync, Visitor } from "oxc-parser";
import type { IfStatement, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { belongsDirectlyToFunction, containsNode, nestedFunctionRanges } from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type DomainFallthrough = "falls-off-end" | "returns-undefined" | "returns-value";

export type DomainHandlingSite = {
  kind: "switch" | "if-chain";
  discriminant: string;
  handledCases: string[];
  hasDefaultOrElse: boolean;
  exhaustivenessAnchor: boolean;
  fallthrough: DomainFallthrough;
  line: number;
  source: string;
};

export type DeclaredDomain = {
  name: string;
  kind: "literal-union" | "enum" | "discriminated-union";
  members: string[];
  discriminantProperty: string | null;
  filePath: string;
  origin: "same-module" | "project-module";
  snippet: string;
};

export type NonExhaustiveDomainHandlingEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  handling: DomainHandlingSite;
  domain: DeclaredDomain;
  missingCases: string[];
  callers: FunctionCaller[];
};

type CollectedSite = {
  kind: "switch" | "if-chain";
  discriminant: string;
  base: string;
  root: string;
  property: string | null;
  handledCases: string[];
  hasDefaultOrElse: boolean;
  start: number;
  end: number;
};

type DomainDeclaration = {
  name: string;
  kind: DeclaredDomain["kind"];
  members: string[];
  discriminantProperty: string | null;
  snippet: string;
};

const EXHAUSTIVE_ANCHOR = /assertNever|assertExhaustive|exhaustiveCheck|satisfies\s+never/;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function normalizeLiteral(text: string): string | undefined {
  const trimmed = text.trim();
  const stringMatch = /^["']([^"']*)["']$/.exec(trimmed);
  if (stringMatch?.[1] !== undefined) return stringMatch[1];
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return trimmed;
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) return trimmed;
  return undefined;
}

function baseOf(text: string): string | undefined {
  const match = /([\w$]+(?:\.[\w$]+|\[['"][^'"]+['"]\]){0,3})/.exec(text.trim());
  return match?.[1]?.replace(/\s+/g, "");
}

function rootOf(base: string): string {
  const match = /^[\w$]+/.exec(base);
  return match?.[0] ?? base;
}

function enumMemberName(testSource: string): string | undefined {
  const match = /\.([\w$]+)$/.exec(testSource.trim());
  return match?.[1];
}

function propertyOf(base: string): string | null {
  const match = /\.([\w$]+)$/.exec(base);
  return match?.[1] ?? null;
}

function collectSites(
  program: Program,
  fn: FunctionNode,
  source: string,
): CollectedSite[] {
  const sites: CollectedSite[] = [];
  const nested: NodeRange[] = nestedFunctionRanges(program, fn);
  const elseIfNodes = new Set<number>();
  new Visitor({
    IfStatement(node) {
      if (node.alternate?.type === "IfStatement") elseIfNodes.add(node.alternate.start);
    },
  }).visit(program);

  new Visitor({
    SwitchStatement(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const discriminant = source.slice(node.discriminant.start, node.discriminant.end);
      const base = baseOf(discriminant);
      if (!base) return;
      const handled: string[] = [];
      let hasDefault = false;
      for (const caseNode of node.cases) {
        if (!caseNode.test) {
          hasDefault = true;
          continue;
        }
        const testSource = source.slice(caseNode.test.start, caseNode.test.end);
        const literal = normalizeLiteral(testSource) ?? enumMemberName(testSource);
        if (literal !== undefined && !handled.includes(literal)) handled.push(literal);
      }
      if (handled.length === 0) return;
      sites.push({
        kind: "switch",
        discriminant,
        base,
        root: rootOf(base),
        property: propertyOf(base),
        handledCases: handled,
        hasDefaultOrElse: hasDefault,
        start: node.start,
        end: node.end,
      });
    },
    IfStatement(node) {
      if (elseIfNodes.has(node.start)) return;
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const comparisons: { base: string; literal: string }[] = [];
      let current: IfStatement | undefined = node;
      let hasElse = false;
      while (current) {
        if (!containsNode(fn, current) || !belongsDirectlyToFunction(current, nested)) break;
        const testSource = source.slice(current.test.start, current.test.end);
        const forward = /([\w$][\w$.[\]'"]*?)\s*===?\s*(["'][^"']*["']|-?\d+(?:\.\d+)?)/.exec(testSource);
        const reversed = /(["'][^"']*["']|-?\d+(?:\.\d+)?)\s*===?\s*([\w$][\w$.[\]'"]*)/.exec(testSource);
        const baseSource = forward?.[1] ?? reversed?.[2];
        const literalSource = forward?.[2] ?? reversed?.[1];
        if (!baseSource || !literalSource) break;
        const base = baseOf(baseSource);
        const literal = normalizeLiteral(literalSource);
        if (!base || literal === undefined) break;
        comparisons.push({ base, literal });
        const alternate: IfStatement["alternate"] = current.alternate;
        if (alternate?.type === "IfStatement") {
          current = alternate;
        } else {
          if (alternate) hasElse = true;
          current = undefined;
        }
      }
      if (comparisons.length === 0) return;
      const firstBase = comparisons[0]?.base;
      if (!firstBase || !comparisons.every(({ base }) => base === firstBase)) return;
      const handled = [...new Set(comparisons.map(({ literal }) => literal))];
      sites.push({
        kind: "if-chain",
        discriminant: firstBase,
        base: firstBase,
        root: rootOf(firstBase),
        property: propertyOf(firstBase),
        handledCases: handled,
        hasDefaultOrElse: hasElse,
        start: node.start,
        end: node.end,
      });
    },
  }).visit(program);
  return sites;
}

function collectDomains(program: Program, source: string): DomainDeclaration[] {
  const domains: DomainDeclaration[] = [];
  new Visitor({
    TSTypeAliasDeclaration(node) {
      if (node.typeAnnotation.type !== "TSUnionType") return;
      const name = node.id.name;
      const literals: string[] = [];
      let discriminated: { property: string; values: string[] } | null = null;
      let allLiteral = true;
      let allObjectWithLiteral = true;
      let sharedProperty: string | null = null;
      const sharedValues: string[] = [];
      for (const member of node.typeAnnotation.types) {
        if (member.type === "TSLiteralType") {
          const literal = normalizeLiteral(source.slice(member.start, member.end));
          if (literal === undefined) {
            allLiteral = false;
          } else if (!literals.includes(literal)) {
            literals.push(literal);
          }
          allObjectWithLiteral = false;
          continue;
        }
        allLiteral = false;
        if (member.type !== "TSTypeLiteral") {
          allObjectWithLiteral = false;
          continue;
        }
        let foundLiteralProp = false;
        for (const item of member.members) {
          if (item.type !== "TSPropertySignature") continue;
          if (item.key.type !== "Identifier") continue;
          if (item.typeAnnotation?.typeAnnotation.type !== "TSLiteralType") continue;
          const annotation = item.typeAnnotation.typeAnnotation;
          const property = item.key.name;
          const value = normalizeLiteral(source.slice(annotation.start, annotation.end));
          if (value === undefined) {
            allObjectWithLiteral = false;
            break;
          }
          if (sharedProperty === null) sharedProperty = property;
          if (sharedProperty !== property) {
            allObjectWithLiteral = false;
            break;
          }
          if (!sharedValues.includes(value)) sharedValues.push(value);
          foundLiteralProp = true;
          break;
        }
        if (!foundLiteralProp) allObjectWithLiteral = false;
      }
      if (allLiteral && literals.length >= 2) {
        domains.push({
          name,
          kind: "literal-union",
          members: literals,
          discriminantProperty: null,
          snippet: source.slice(node.start, node.end).slice(0, 500),
        });
        return;
      }
      if (allObjectWithLiteral && sharedProperty && sharedValues.length >= 2) {
        discriminated = { property: sharedProperty, values: sharedValues };
      }
      if (discriminated) {
        domains.push({
          name,
          kind: "discriminated-union",
          members: discriminated.values,
          discriminantProperty: discriminated.property,
          snippet: source.slice(node.start, node.end).slice(0, 500),
        });
      }
    },
    TSEnumDeclaration(node) {
      const name = node.id.name;
      const members: string[] = [];
      for (const member of node.body.members) {
        const id = member.id;
        const raw = id.type === "Identifier" ? id.name : source.slice(id.start, id.end);
        const literal = normalizeLiteral(raw);
        if (literal === undefined || members.includes(literal)) continue;
        members.push(literal);
      }
      if (members.length >= 2) {
        domains.push({
          name,
          kind: "enum",
          members,
          discriminantProperty: null,
          snippet: source.slice(node.start, node.end).slice(0, 500),
        });
      }
    },
  }).visit(program);
  return domains;
}

function parameterTypeNames(fn: FunctionNode, source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const parameter of fn.params) {
    const text = source.slice(parameter.start, parameter.end);
    const nameMatch = /^[\w$]+/.exec(text.trim());
    const typeMatch = /:\s*([A-Za-z_$][\w$]*)/.exec(text);
    if (nameMatch?.[0] && typeMatch?.[1]) result.set(nameMatch[0], typeMatch[1]);
  }
  return result;
}

function fallthroughOf(source: string, fn: FunctionNode, site: CollectedSite): DomainFallthrough {
  const tail = source.slice(site.end, fn.end).replace(/\}\s*$/, "");
  if (/\bthrow\b/.test(tail) || /\breturn\b(?!\s*;|\s*undefined\s*;)/.test(tail)) return "returns-value";
  if (/\breturn\b/.test(tail)) return "returns-undefined";
  return "falls-off-end";
}

export function buildNonExhaustiveDomainHandlingEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): NonExhaustiveDomainHandlingEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);

  const sites = collectSites(parsed.program, fn, owner.source);
  if (sites.length === 0) return undefined;
  const fnSource = owner.source.slice(fn.start, fn.end);
  const anchored = EXHAUSTIVE_ANCHOR.test(fnSource);

  const ownerDomains = collectDomains(parsed.program, owner.source).map((domain) => ({
    ...domain,
    filePath: owner.filePath,
    origin: "same-module" as const,
  }));
  const importedDomains = moduleImports(parsed.program).flatMap((imported) => {
    const resolved = resolveModule(owner.filePath, imported.source, projectFiles);
    if (!resolved) return [];
    const moduleParsed = parseSync(resolved.filePath, resolved.source, { range: true });
    if (moduleParsed.errors.some((error) => error.severity === "Error")) return [];
    return collectDomains(moduleParsed.program, resolved.source).map((domain) => ({
      ...domain,
      filePath: resolved.filePath,
      origin: "project-module" as const,
    }));
  });
  const domains = [...ownerDomains, ...importedDomains];
  if (domains.length === 0) return undefined;

  const parameterTypes = parameterTypeNames(fn, owner.source);

  const eligible = sites.flatMap((site) => {
    if (site.hasDefaultOrElse || anchored) return [];
    const typeName = parameterTypes.get(site.root);
    const matches = domains.filter((domain) => {
      if (domain.kind === "discriminated-union") {
        return domain.name === typeName
          && domain.discriminantProperty === site.property
          && site.property !== null;
      }
      return domain.name === typeName;
    });
    return matches.map((domain) => ({ site, domain }));
  }).filter(({ site, domain }) => site.handledCases.some((handled) => domain.members.includes(handled)));

  const withMissing = eligible
    .map(({ site, domain }) => ({
      site,
      domain,
      missing: domain.members.filter((member) => !site.handledCases.includes(member)),
    }))
    .filter(({ missing }) => missing.length > 0);
  if (withMissing.length === 0) return undefined;

  const best = [...withMissing].sort(
    (left, right) => right.missing.length - left.missing.length || right.site.handledCases.length - left.site.handledCases.length,
  )[0];
  if (!best) return undefined;

  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    handling: {
      kind: best.site.kind,
      discriminant: best.site.discriminant,
      handledCases: best.site.handledCases,
      hasDefaultOrElse: best.site.hasDefaultOrElse,
      exhaustivenessAnchor: anchored,
      fallthrough: fallthroughOf(owner.source, fn, best.site),
      line: lineAt(owner.source, best.site.start),
      source: owner.source.slice(best.site.start, best.site.end).slice(0, 2000),
    },
    domain: {
      name: best.domain.name,
      kind: best.domain.kind,
      members: best.domain.members,
      discriminantProperty: best.domain.discriminantProperty,
      filePath: best.domain.filePath,
      origin: best.domain.origin,
      snippet: best.domain.snippet,
    },
    missingCases: best.missing,
    callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
  };
}
