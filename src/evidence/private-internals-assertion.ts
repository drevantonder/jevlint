import { Visitor } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  isInsideNestedFunction,
  moduleImports,
  nestedFunctionRanges,
  resolveModule,
} from "./repository.js";
import { parseTestFunction } from "./test-scope.js";

export type DeepImportEvidence = {
  source: string;
  imported: string;
};

export type PrivateInternalsAssertionEvidence = {
  function: {
    title: string | null;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  deepImports: DeepImportEvidence[];
  anyCasts: string[];
  privateAccesses: string[];
  publicEntryAvailable: boolean;
};

function bypassesBarrel(source: string): boolean {
  if (!source.startsWith(".")) return source.split("/").includes("internal");
  const segments = source.split("/");
  const parentHops = segments.filter((segment) => segment === "..").length;
  return parentHops >= 2 || segments.includes("internal");
}

export function buildPrivateInternalsAssertionEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): PrivateInternalsAssertionEvidence | undefined {
  const scope = parseTestFunction(candidate, projectFiles);
  if (!scope) return undefined;
  if (scope.runner !== "it" && scope.runner !== "test") return undefined;
  const { owner, program, fn } = scope;
  const nested = nestedFunctionRanges(program, candidate);

  const deepImports: DeepImportEvidence[] = [];
  for (const entry of moduleImports(program)) {
    if (bypassesBarrel(entry.source)) {
      deepImports.push({ source: entry.source, imported: entry.imported });
    }
  }

  const anyCasts: string[] = [];
  const privateAccesses: string[] = [];
  const seen = new Set<number>();
  new Visitor({
    TSAsExpression(node) {
      if (node.start < fn.start || node.end > fn.end) return;
      if (isInsideNestedFunction(node, nested)) return;
      if (node.typeAnnotation.type === "TSAnyKeyword" && !seen.has(node.start)) {
        seen.add(node.start);
        anyCasts.push(owner.source.slice(node.start, node.end).slice(0, 300));
      }
    },
    MemberExpression(node) {
      if (node.start < fn.start || node.end > fn.end) return;
      if (isInsideNestedFunction(node, nested)) return;
      const property = node.property;
      if (property.type === "PrivateIdentifier") {
        privateAccesses.push(owner.source.slice(node.start, node.end).slice(0, 300));
        return;
      }
      if (
        !node.computed
        && property.type === "Identifier"
        && /^_[^_]/u.test(property.name)
        && !seen.has(node.start)
      ) {
        seen.add(node.start);
        privateAccesses.push(owner.source.slice(node.start, node.end).slice(0, 300));
      }
    },
  }).visit(program);

  if (deepImports.length === 0 && anyCasts.length === 0 && privateAccesses.length === 0) {
    return undefined;
  }

  let publicEntryAvailable = false;
  for (const entry of moduleImports(program)) {
    if (!entry.source.startsWith(".")) continue;
    const resolved = resolveModule(owner.filePath, entry.source, projectFiles);
    if (!resolved) continue;
    const segments = resolved.filePath.split("/");
    for (let depth = 1; depth <= 3; depth += 1) {
      const directory = segments.slice(0, -depth).join("/");
      const barrel = projectFiles.some((file) =>
        /\/index\.[cm]?[jt]sx?$/.test(file.filePath)
        && file.filePath.split("/").slice(0, -1).join("/") === directory
        && file.filePath !== resolved.filePath,
      );
      if (barrel) {
        publicEntryAvailable = true;
        break;
      }
    }
    if (publicEntryAvailable) break;
  }
  return {
    function: {
      title: scope.title,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    deepImports: deepImports.slice(0, 10),
    anyCasts: anyCasts.slice(0, 10),
    privateAccesses: privateAccesses.slice(0, 10),
    publicEntryAvailable,
  };
}
