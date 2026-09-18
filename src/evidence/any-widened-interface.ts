import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  belongsDirectlyToFunction,
  containsNode,
  nestedFunctionRanges,
} from "./function-scope.js";
import type { NodeRange } from "./function-scope.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findRelatedProjectModules,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionCaller, FunctionNode, RelatedProjectModule } from "./repository.js";

export type AnyWidenedPosition = "parameter" | "return";

export type AnyWidenedSite = {
  position: AnyWidenedPosition;
  /** Parameter name for parameter sites; null for return sites and destructured params. */
  name: string | null;
  annotation: string;
  line: number;
};

export type AnyWidenedInterfaceEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  widenedPositions: AnyWidenedSite[];
  internalAnyNotes: string[];
  genericConstraintAny: boolean;
  hasExplicitAnyDisable: boolean;
  narrowerAlternativesNearby: string[];
  repository: {
    callers: FunctionCaller[];
    relatedModules: RelatedProjectModule[];
  };
};

const MAX_NOTES = 8;
const MAX_ALTERNATIVES = 12;

const EXPLICIT_ANY_DISABLE_PATTERN =
  /eslint-disable.*no-explicit-any|@ts-(expect-error|ignore)/;

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function lineText(source: string, offset: number): string {
  const line = lineAt(source, offset);
  return source.split("\n")[line - 1]?.trim() ?? "";
}

function inRange(range: NodeRange | undefined, offset: number): boolean {
  return range !== undefined && range.start <= offset && offset < range.end;
}


function paramName(parameter: FunctionNode["params"][number]): string | null {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  if (value.type === "Identifier") return value.name;
  if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
    return value.left.name;
  }
  if (value.type === "RestElement" && value.argument.type === "Identifier") {
    return value.argument.name;
  }
  return null;
}

function paramAnnotationText(
  source: string,
  parameter: FunctionNode["params"][number],
): string {
  const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
  // SAFETY: every binding pattern in a parameter position carries an optional
  // typeAnnotation range when annotated; the read below only slices source text.
  const holder = value as { typeAnnotation?: NodeRange | null | undefined };
  if (holder.typeAnnotation) {
    return source.slice(holder.typeAnnotation.start, holder.typeAnnotation.end)
      .replace(/^:\s*/, "").trim();
  }
  return source.slice(parameter.start, parameter.end).trim();
}

function localTypeNames(program: Program): string[] {
  const names: string[] = [];
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (
      declaration?.type === "TSInterfaceDeclaration"
      || declaration?.type === "TSTypeAliasDeclaration"
      || declaration?.type === "TSEnumDeclaration"
    ) {
      const name = declaration.id.name;
      if (!names.includes(name)) names.push(name);
    } else if (declaration?.type === "ClassDeclaration") {
      const name = declaration.id?.name;
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

export function buildAnyWidenedInterfaceEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): AnyWidenedInterfaceEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const source = ownerFile.source;
  const nested = nestedFunctionRanges(parsed.program, fn);
  const params = fn.params;
  const returnType: NodeRange | undefined = fn.returnType ?? undefined;
  const typeParameters: NodeRange | undefined = fn.typeParameters ?? undefined;

  const widenedPositions: AnyWidenedSite[] = [];
  const internalAnyNotes: string[] = [];
  let genericConstraintAny = false;
  let seenAny = false;

  const recordWidened = (
    position: AnyWidenedPosition,
    name: string | null,
    annotation: string,
    offset: number,
  ): void => {
    const key = `${position}:${name ?? ""}:${annotation}`;
    if (widenedPositions.some((site) =>
      `${site.position}:${site.name ?? ""}:${site.annotation}` === key
    )) return;
    widenedPositions.push({ position, name, annotation, line: lineAt(source, offset) });
  };

  new Visitor({
    TSAnyKeyword(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      seenAny = true;
      const paramIndex = params.findIndex((parameter) =>
        parameter.start <= node.start && node.end <= parameter.end
      );
      if (paramIndex >= 0) {
        const parameter = params[paramIndex];
        if (!parameter) return;
        recordWidened(
          "parameter",
          paramName(parameter),
          paramAnnotationText(source, parameter),
          node.start,
        );
        return;
      }
      if (returnType && inRange(returnType, node.start)) {
        recordWidened(
          "return",
          null,
          source.slice(returnType.start, returnType.end)
            .replace(/^:\s*/, "").trim(),
          node.start,
        );
        return;
      }
      if (inRange(typeParameters, node.start)) {
        genericConstraintAny = true;
        return;
      }
      if (internalAnyNotes.length < MAX_NOTES) {
        internalAnyNotes.push(`line ${lineAt(source, node.start)}: ${lineText(source, node.start)}`);
      }
    },
    TSAsExpression(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const asserted = source.slice(node.typeAnnotation.start, node.typeAnnotation.end);
      if (!/\bany\b/.test(asserted)) return;
      if (internalAnyNotes.length < MAX_NOTES) {
        internalAnyNotes.push(`line ${lineAt(source, node.start)}: ${lineText(source, node.start)}`);
      }
    },
    TSTypeAssertion(node) {
      if (!containsNode(fn, node) || !belongsDirectlyToFunction(node, nested)) return;
      const asserted = source.slice(node.typeAnnotation.start, node.typeAnnotation.end);
      if (!/\bany\b/.test(asserted)) return;
      if (internalAnyNotes.length < MAX_NOTES) {
        internalAnyNotes.push(`line ${lineAt(source, node.start)}: ${lineText(source, node.start)}`);
      }
    },
  }).visit(parsed.program);

  if (!seenAny) return undefined;

  let hasExplicitAnyDisable = false;
  for (const comment of parsed.comments ?? []) {
    if (comment.start < fn.start || comment.end > fn.end) continue;
    if (EXPLICIT_ANY_DISABLE_PATTERN.test(comment.value)) {
      hasExplicitAnyDisable = true;
      break;
    }
  }

  const alternatives = [...localTypeNames(parsed.program)];
  for (const imp of moduleImports(parsed.program)) {
    if (!alternatives.includes(imp.local)) alternatives.push(imp.local);
  }

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    widenedPositions,
    internalAnyNotes,
    genericConstraintAny,
    hasExplicitAnyDisable,
    narrowerAlternativesNearby: alternatives.slice(0, MAX_ALTERNATIVES),
    repository: {
      callers: name ? findFunctionCallers(candidate.filePath, name, projectFiles) : [],
      relatedModules: findRelatedProjectModules(
        candidate.filePath,
        parsed.program,
        projectFiles,
      ),
    },
  };
}