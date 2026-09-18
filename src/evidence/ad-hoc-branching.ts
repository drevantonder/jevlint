import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  isInsideNestedFunction,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

type BranchEvidence = {
  kind: "if" | "switch" | "conditional";
  condition: string;
  branch: string;
};

export type AdHocBranchingEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  branches: BranchEvidence[];
  callers: FunctionCaller[];
};

export function buildAdHocBranchingEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): AdHocBranchingEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const branches: BranchEvidence[] = [];
  const nestedFunctions = nestedFunctionRanges(parsed.program, candidate);
  new Visitor({
    IfStatement(node) {
      if (
        node.start < candidate.start
        || node.end > candidate.end
        || isInsideNestedFunction(node, nestedFunctions)
      ) return;
      branches.push({
        kind: "if",
        condition: owner.source.slice(node.test.start, node.test.end),
        branch: owner.source.slice(node.consequent.start, node.consequent.end),
      });
    },
    SwitchStatement(node) {
      if (
        node.start < candidate.start
        || node.end > candidate.end
        || isInsideNestedFunction(node, nestedFunctions)
      ) return;
      branches.push({
        kind: "switch",
        condition: `switch ${owner.source.slice(node.discriminant.start, node.discriminant.end)}`,
        branch: owner.source.slice(node.start, node.end),
      });
    },
    ConditionalExpression(node) {
      if (
        node.start < candidate.start
        || node.end > candidate.end
        || isInsideNestedFunction(node, nestedFunctions)
      ) return;
      branches.push({
        kind: "conditional",
        condition: owner.source.slice(node.test.start, node.test.end),
        branch: owner.source.slice(node.start, node.end),
      });
    },
  }).visit(parsed.program);

  const enoughStructure = branches.length >= 2
    || branches.some((branch) => branch.kind === "switch" && branch.branch.includes("case "));
  if (!enoughStructure) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    branches,
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
