import { parseSync, Visitor } from "oxc-parser";
import type { ConditionalExpression, IfStatement, Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

type PredicateSignature = {
  memberNames: string[];
  literalValues: string[];
  operators: string[];
};

type PolicyBranch = {
  kind: "if" | "conditional";
  condition: string;
  outcome: string;
  line: number;
  signature: PredicateSignature;
};

type RepositoryPolicyMatch = PolicyBranch & {
  filePath: string;
  functionName: string;
  moduleSource: string;
};

type ScatteredPolicy = {
  candidate: PolicyBranch;
  repositoryMatches: RepositoryPolicyMatch[];
};

export type ScatteredPolicyEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  scatteredPolicies: ScatteredPolicy[];
  callers: FunctionCaller[];
};

type LocatedFunction = {
  node: FunctionNode;
  name: string;
};

type LocatedBranch = {
  owner: LocatedFunction;
  branch: PolicyBranch;
  fingerprint: string;
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function literalText(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const first = raw[0];
  const last = raw.at(-1);
  if ((first === "\"" || first === "'") && last === first) return raw.slice(1, -1);
  return raw;
}

function predicateSignature(condition: string): PredicateSignature | undefined {
  const wrapped = `const __policy = (${condition});`;
  const parsed = parseSync("policy.ts", wrapped, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const memberNames = new Set<string>();
  const literalValues = new Set<string>();
  const operators: string[] = [];
  new Visitor({
    BinaryExpression(node) {
      operators.push(node.operator);
    },
    LogicalExpression(node) {
      operators.push(node.operator);
    },
    UnaryExpression(node) {
      operators.push(node.operator);
    },
    MemberExpression(node) {
      const property = node.property;
      if (!node.computed && property.type === "Identifier") {
        memberNames.add(property.name);
      } else if (node.computed && property.type === "Literal") {
        const value = literalText(property.raw);
        if (value !== undefined) memberNames.add(value);
      }
    },
    Literal(node) {
      const value = literalText(node.raw);
      if (value !== undefined) literalValues.add(value);
    },
  }).visit(parsed.program);
  const signature = {
    memberNames: [...memberNames].sort(),
    literalValues: [...literalValues].sort(),
    operators: operators.sort(),
  };
  if (signature.operators.length === 0) return undefined;
  if (signature.memberNames.length + signature.literalValues.length < 3) return undefined;
  return signature;
}

function functionsIn(program: Program): LocatedFunction[] {
  const functions: LocatedFunction[] = [];
  const add = (node: FunctionNode): void => {
    const name = functionName(program, node);
    if (name) functions.push({ node, name });
  };
  new Visitor({
    ArrowFunctionExpression: add,
    FunctionDeclaration: add,
    FunctionExpression: add,
  }).visit(program);
  return functions;
}

function containingFunction(
  start: number,
  end: number,
  functions: LocatedFunction[],
): LocatedFunction | undefined {
  return functions
    .filter(({ node }) => node.start <= start && node.end >= end)
    .sort((left, right) =>
      (left.node.end - left.node.start) - (right.node.end - right.node.start),
    )[0];
}

function branchEvidence(
  node: IfStatement | ConditionalExpression,
  source: string,
): PolicyBranch | undefined {
  const signature = predicateSignature(source.slice(node.test.start, node.test.end));
  if (!signature) return undefined;
  return {
    kind: node.type === "IfStatement" ? "if" : "conditional",
    condition: source.slice(node.test.start, node.test.end),
    outcome: node.type === "IfStatement"
      ? source.slice(node.consequent.start, node.consequent.end)
      : source.slice(node.start, node.end),
    line: lineAt(source, node.start),
    signature,
  };
}

function branchesIn(file: ProjectFile): { program: Program; branches: LocatedBranch[] } | undefined {
  const parsed = parseSync(file.filePath, file.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const functions = functionsIn(parsed.program);
  const branches: LocatedBranch[] = [];
  const add = (node: IfStatement | ConditionalExpression): void => {
    const owner = containingFunction(node.start, node.end, functions);
    if (!owner) return;
    const branch = branchEvidence(node, file.source);
    if (!branch) return;
    branches.push({ owner, branch, fingerprint: JSON.stringify(branch.signature) });
  };
  new Visitor({
    IfStatement: add,
    ConditionalExpression: add,
  }).visit(parsed.program);
  return { program: parsed.program, branches };
}

export function buildScatteredPolicyEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ScatteredPolicyEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const ownerEvidence = branchesIn(owner);
  if (!ownerEvidence) return undefined;
  const fn = findDirectFunction(ownerEvidence.program, candidate);
  if (!fn) return undefined;
  const name = functionName(ownerEvidence.program, fn);
  if (!name) return undefined;

  const candidateBranches = ownerEvidence.branches.filter(({ owner: branchOwner }) =>
    branchOwner.node.start === fn.start && branchOwner.node.end === fn.end,
  );
  if (candidateBranches.length === 0) return undefined;

  const repositoryBranches = projectFiles.flatMap((file): RepositoryPolicyMatch[] => {
    if (file.filePath === owner.filePath) return [];
    const evidence = branchesIn(file);
    if (!evidence) return [];
    return evidence.branches.map(({ owner: branchOwner, branch }) => ({
      ...branch,
      filePath: file.filePath,
      functionName: branchOwner.name,
      moduleSource: file.source.slice(0, 8_000),
    }));
  });
  const matchesByFingerprint = new Map<string, RepositoryPolicyMatch[]>();
  for (const match of repositoryBranches) {
    const fingerprint = JSON.stringify(match.signature);
    const matches = matchesByFingerprint.get(fingerprint) ?? [];
    matches.push(match);
    matchesByFingerprint.set(fingerprint, matches);
  }

  const scatteredPolicies = candidateBranches.flatMap(({ branch, fingerprint }): ScatteredPolicy[] => {
    const matches = matchesByFingerprint.get(fingerprint);
    return matches && matches.length > 0
      ? [{ candidate: branch, repositoryMatches: matches.slice(0, 12) }]
      : [];
  });
  if (scatteredPolicies.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(ownerEvidence.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    scatteredPolicies,
    callers: findFunctionCallers(owner.filePath, name, projectFiles),
  };
}
