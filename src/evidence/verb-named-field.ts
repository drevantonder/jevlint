import { Visitor } from "oxc-parser";
import type { Program, PropertyKey } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";

export type VerbNamedFieldFinding = {
  name: string;
  verb: string;
  declaredType: string | null;
  source: string;
};

export type VerbNamedFieldExclusion = {
  name: string;
  reason: "function-typed" | "predicate-prefix";
  source: string;
};

export type VerbNamedFieldEvidence = {
  abstraction: {
    name: string;
    kind: "class" | "interface" | "type-alias";
    filePath: string;
    source: string;
  };
  findings: VerbNamedFieldFinding[];
  excluded: VerbNamedFieldExclusion[];
  memberCount: number;
};

// Imperative verb stems that, leading a stored-state member name, imply the
// member performs an action. Kept deliberately narrow: morphology alone flags
// the shape while the evaluator weighs whether the stored type contradicts it.
const VERB_STEMS = new Set([
  "add",
  "alert",
  "analyze",
  "append",
  "apply",
  "approve",
  "archive",
  "assert",
  "assign",
  "attach",
  "block",
  "build",
  "cache",
  "calculate",
  "cancel",
  "check",
  "claim",
  "clean",
  "clear",
  "close",
  "collapse",
  "compute",
  "confirm",
  "convert",
  "copy",
  "create",
  "deactivate",
  "delete",
  "deny",
  "deploy",
  "detach",
  "disable",
  "dispatch",
  "download",
  "drag",
  "drop",
  "edit",
  "emit",
  "enable",
  "execute",
  "expand",
  "export",
  "fetch",
  "fill",
  "filter",
  "find",
  "fire",
  "focus",
  "follow",
  "format",
  "generate",
  "handle",
  "hide",
  "highlight",
  "import",
  "insert",
  "install",
  "invite",
  "invoke",
  "join",
  "kick",
  "leave",
  "like",
  "load",
  "lock",
  "log",
  "make",
  "measure",
  "merge",
  "migrate",
  "mock",
  "move",
  "mute",
  "normalize",
  "notify",
  "open",
  "parse",
  "pop",
  "post",
  "print",
  "process",
  "publish",
  "push",
  "refresh",
  "register",
  "reject",
  "release",
  "remind",
  "remove",
  "rename",
  "render",
  "reply",
  "reset",
  "resolve",
  "retrieve",
  "retry",
  "run",
  "sanitize",
  "save",
  "schedule",
  "scroll",
  "search",
  "select",
  "send",
  "set",
  "share",
  "shift",
  "show",
  "sort",
  "split",
  "start",
  "stop",
  "store",
  "submit",
  "subscribe",
  "sync",
  "test",
  "toggle",
  "track",
  "transform",
  "trigger",
  "unfollow",
  "unlock",
  "unmute",
  "update",
  "upload",
  "validate",
  "verify",
]);

// Predicate-shaped prefixes belong to predicate-name reasoning (function
// predicates and boolean claims), never to this verb-form proposition.
const PREDICATE_PREFIX = /^(is|has|have|can|should|needs?|will|did|was|were|are)[A-Z]/;

// A declared function type, a known callable nominal, or a closure
// initializer marks a callback noun rather than stored state.
const FUNCTION_TYPE = /=>/;
const CALLABLE_NOMINAL = /^\s*(Function|Callable|Callback|Handler|Listener)\b/;

type Field = {
  name: string;
  declaredType: string | null;
  initializerIsFunction: boolean;
  source: string;
};

type Declaration = {
  name: string;
  kind: "class" | "interface" | "type-alias";
  fields: Field[];
};

function firstSegment(name: string): string {
  const stripped = name.replace(/^#+/, "").replace(/^_+/, "");
  const snakeHead = stripped.split("_")[0] ?? "";
  return snakeHead.match(/^[a-z]+/)?.[0] ?? snakeHead.toLowerCase();
}

function annotationOf(source: string, node: { start: number; end: number }): string | null {
  const text = source.slice(node.start, node.end).replace(/^:\s*/, "").trim();
  return text.length > 0 ? text : null;
}

function identifierKey(key: PropertyKey): string | undefined {
  if (key.type === "Identifier") return key.name;
  if (key.type === "PrivateIdentifier") return `#${key.name}`;
  return undefined;
}

function collectDeclaration(
  program: Program,
  candidate: Candidate,
  ownerSource: string,
): Declaration | undefined {
  let result: Declaration | undefined;
  const matches = (node: { start: number; end: number }): boolean =>
    node.start === candidate.start && node.end === candidate.end;

  new Visitor({
    ClassDeclaration(node) {
      if (!matches(node) || node.id?.type !== "Identifier") return;
      const fields: Field[] = [];
      for (const element of node.body.body) {
        if (element.type !== "PropertyDefinition" || element.static) continue;
        const name = element.key.type === "Identifier" || element.key.type === "PrivateIdentifier"
          ? identifierKey(element.key)
          : undefined;
        if (!name) continue;
        const annotation = element.typeAnnotation
          ? annotationOf(ownerSource, element.typeAnnotation)
          : null;
        fields.push({
          name,
          declaredType: annotation,
          initializerIsFunction: element.value?.type === "ArrowFunctionExpression"
            || element.value?.type === "FunctionExpression",
          source: ownerSource.slice(element.start, element.end).slice(0, 300),
        });
      }
      result = { name: node.id.name, kind: "class", fields };
    },
    TSInterfaceDeclaration(node) {
      if (!matches(node)) return;
      const fields: Field[] = [];
      for (const member of node.body.body) {
        if (member.type !== "TSPropertySignature" || member.computed) continue;
        const name = identifierKey(member.key);
        if (!name) continue;
        fields.push({
          name,
          declaredType: member.typeAnnotation
            ? annotationOf(ownerSource, member.typeAnnotation)
            : null,
          initializerIsFunction: false,
          source: ownerSource.slice(member.start, member.end).slice(0, 300),
        });
      }
      result = { name: node.id.name, kind: "interface", fields };
    },
    TSTypeAliasDeclaration(node) {
      if (!matches(node) || node.typeAnnotation.type !== "TSTypeLiteral") return;
      const fields: Field[] = [];
      for (const member of node.typeAnnotation.members) {
        if (member.type !== "TSPropertySignature" || member.computed) continue;
        const name = identifierKey(member.key);
        if (!name) continue;
        fields.push({
          name,
          declaredType: member.typeAnnotation
            ? annotationOf(ownerSource, member.typeAnnotation)
            : null,
          initializerIsFunction: false,
          source: ownerSource.slice(member.start, member.end).slice(0, 300),
        });
      }
      result = { name: node.id.name, kind: "type-alias", fields };
    },
  }).visit(program);
  return result;
}

function isFunctionTyped(field: Field): boolean {
  if (field.initializerIsFunction) return true;
  if (field.declaredType === null) return false;
  return FUNCTION_TYPE.test(field.declaredType) || CALLABLE_NOMINAL.test(field.declaredType);
}

export function buildVerbNamedFieldEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): VerbNamedFieldEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const declaration = collectDeclaration(parsed.program, candidate, owner.source);
  if (!declaration || declaration.fields.length === 0) return undefined;

  const findings: VerbNamedFieldFinding[] = [];
  const excluded: VerbNamedFieldExclusion[] = [];
  for (const field of declaration.fields) {
    const verb = firstSegment(field.name);
    if (!VERB_STEMS.has(verb)) continue;
    if (PREDICATE_PREFIX.test(field.name)) {
      excluded.push({ name: field.name, reason: "predicate-prefix", source: field.source });
      continue;
    }
    if (isFunctionTyped(field)) {
      excluded.push({ name: field.name, reason: "function-typed", source: field.source });
      continue;
    }
    findings.push({
      name: field.name,
      verb,
      declaredType: field.declaredType,
      source: field.source,
    });
  }
  if (findings.length === 0) return undefined;

  return {
    abstraction: {
      name: declaration.name,
      kind: declaration.kind,
      filePath: owner.filePath,
      source: candidate.source,
    },
    findings,
    excluded,
    memberCount: declaration.fields.length,
  };
}
