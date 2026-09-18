import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Candidate, ProjectFile } from "../types.js";
import type { Program } from "oxc-parser";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  moduleImports,
  resolveModule,
} from "./repository.js";
import type { FunctionCaller, FunctionNode } from "./repository.js";

export type ExcessParameter = {
  name: string;
  source: string;
  destructured: boolean;
  annotation: string | null;
  declaredProperties: string[] | null;
};

export type ExcessContextParameterEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  parameter: ExcessParameter;
  usage: {
    memberPaths: string[];
    distinctMembers: number;
    forwardedWhole: boolean;
    forwardedTo: string[];
  };
  repository: {
    callers: FunctionCaller[];
    sameTypeSiblings: string[];
  };
};

function annotationOf(paramSource: string): string | null {
  const match = /:\s*([A-Za-z_$][\w$]*(?:\s*\[[^\]]*\])?)\s*(?:=|$)/.exec(paramSource);
  return match?.[1]?.replaceAll(/\s+/g, "") ?? null;
}

function rootName(name: string): string {
  const bracket = name.indexOf("[");
  return bracket === -1 ? name : name.slice(0, bracket);
}

function declaredMembersOf(program: Program, typeName: string): string[] | null {
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (
      (declaration?.type === "TSInterfaceDeclaration" || declaration?.type === "TSTypeAliasDeclaration")
      && declaration.id.name === typeName
    ) {
      if (declaration.type === "TSInterfaceDeclaration") {
        return declaration.body.body.flatMap((member) =>
          member.type === "TSPropertySignature" && member.key.type === "Identifier"
            ? [member.key.name]
            : []
        );
      }
      const aliased = declaration.typeAnnotation;
      if (aliased.type === "TSTypeLiteral") {
        return aliased.members.flatMap((member) =>
          member.type === "TSPropertySignature" && member.key.type === "Identifier"
            ? [member.key.name]
            : []
        );
      }
      return null;
    }
  }
  return null;
}

type ParamBinding =
  | { kind: "identifier"; name: string; source: string }
  | { kind: "destructured"; props: string[]; source: string };

function paramBindings(fn: FunctionNode, source: string): ParamBinding[] {
  const bindings: ParamBinding[] = [];
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    const text = source.slice(parameter.start, parameter.end);
    if (value.type === "Identifier") {
      bindings.push({ kind: "identifier", name: value.name, source: text });
    } else if (value.type === "ObjectPattern") {
      const props: string[] = [];
      for (const property of value.properties) {
        if (property.type === "Property" && property.key.type === "Identifier") {
          props.push(property.key.name);
        }
      }
      if (props.length > 0) bindings.push({ kind: "destructured", props, source: text });
    } else if (
      value.type === "AssignmentPattern" && value.left.type === "Identifier"
      && (value.right.type === "ObjectExpression" || value.right.type === "Identifier")
    ) {
      bindings.push({ kind: "identifier", name: value.left.name, source: text });
    }
  }
  return bindings;
}

export function buildExcessContextParameterEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ExcessContextParameterEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseCached(owner.filePath, owner.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const bindings = paramBindings(fn, owner.source);
  if (bindings.length === 0) return undefined;

  const memberPaths = new Map<string, Set<string>>();
  const forwardedTo = new Map<string, Set<string>>();
  const returnedWhole = new Set<string>();
  for (const binding of bindings) {
    if (binding.kind === "identifier") {
      memberPaths.set(binding.name, new Set());
      forwardedTo.set(binding.name, new Set());
    }
  }

  new Visitor({
    MemberExpression(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      let current = node;
      while (current.object.type === "MemberExpression") current = current.object;
      if (current.object.type !== "Identifier") return;
      const root = current.object.name;
      const paths = memberPaths.get(root);
      if (!paths) return;
      paths.add(owner.source.slice(node.start, node.end));
    },
    CallExpression(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      const calleeText = owner.source.slice(node.callee.start, node.callee.end);
      for (const argument of node.arguments) {
        if (argument.type === "Identifier" && memberPaths.has(argument.name)) {
          forwardedTo.get(argument.name)?.add(calleeText);
        }
      }
    },
    ReturnStatement(node) {
      if (node.start < candidate.start || node.end > candidate.end) return;
      if (node.argument?.type === "Identifier" && memberPaths.has(node.argument.name)) {
        returnedWhole.add(node.argument.name);
      }
    },
  }).visit(parsed.program);

  type Scored = {
    binding: ParamBinding;
    annotation: string | null;
    declared: string[] | null;
    used: string[];
    forwardedWhole: boolean;
    forwardedTargets: string[];
  };

  const scored: Scored[] = bindings.map((binding) => {
    const annotation = annotationOf(binding.source);
    const declaredInOwner = annotation ? declaredMembersOf(parsed.program, rootName(annotation)) : null;
    // Config bindings usually live in their own module; follow the type import
    // one hop so Jev sees the declared width, not just the used members.
    let declared = declaredInOwner;
    if (declared === null && annotation) {
      const typeName = rootName(annotation);
      const imported = moduleImports(parsed.program).find(({ local }) => local === typeName);
      const target = imported
        ? resolveModule(owner.filePath, imported.source, projectFiles)
        : undefined;
      if (target && target.filePath !== owner.filePath) {
        const targetParsed = parseCached(target.filePath, target.source);
        if (!targetParsed.errors.some((error) => error.severity === "Error")) {
          declared = declaredMembersOf(targetParsed.program, typeName);
        }
      }
    }
    if (binding.kind === "destructured") {
      const used = binding.props.filter((prop) =>
        new RegExp(`\\b${prop}\\b`).test(owner.source.slice(fn.body?.start ?? candidate.start, fn.body?.end ?? candidate.end))
      );
      return {
        binding,
        annotation,
        declared: binding.props,
        used,
        forwardedWhole: false,
        forwardedTargets: [],
      };
    }
    const paths = [...(memberPaths.get(binding.name) ?? [])];
    const memberRoots = new Set(
      paths.map((path) => {
        const rest = path.slice(binding.name.length).replace(/^\?\./, ".").replace(/^\./, "");
        const segment = rest.split(/[.?[\]]/)[0] ?? "";
        return segment;
      }).filter((segment) => segment !== ""),
    );
    const targets = [...(forwardedTo.get(binding.name) ?? [])];
    return {
      binding,
      annotation,
      declared,
      used: [...memberRoots],
      forwardedWhole: targets.length > 0 || returnedWhole.has(binding.name),
      forwardedTargets: targets,
    };
  });

  // A parameter used only as a whole (forwarded or returned) justifies its
  // width; a parameter with no member use is a different smell. Either way
  // there is nothing for this proposition to judge.
  const eligible = scored.filter(({ used, forwardedWhole }) => used.length > 0 && !forwardedWhole);
  if (eligible.length === 0) return undefined;
  eligible.sort((left, right) => left.used.length - right.used.length);
  const pick = eligible[0];
  if (!pick) return undefined;

  const paramName = pick.binding.kind === "identifier" ? pick.binding.name : pick.binding.props.join(", ");
  const sameTypeSiblings: string[] = [];
  if (pick.annotation) {
    const typeName = rootName(pick.annotation);
    new Visitor({
      FunctionDeclaration(node) {
        if (node.start === fn.start && node.end === fn.end) return;
        if (!node.id?.name || node.id.name === name) return;
        const paramsText = node.params
          .map((param) => owner.source.slice(param.start, param.end))
          .join(", ");
        if (new RegExp(`:\\s*${typeName}\\b`).test(paramsText)) {
          sameTypeSiblings.push(node.id.name);
        }
      },
    }).visit(parsed.program);
  }

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: owner.filePath,
      source: candidate.source,
    },
    parameter: {
      name: paramName,
      source: pick.binding.source,
      destructured: pick.binding.kind === "destructured",
      annotation: pick.annotation,
      declaredProperties: pick.declared,
    },
    usage: {
      memberPaths: (pick.binding.kind === "identifier"
        ? [...(memberPaths.get(pick.binding.name) ?? [])]
        : pick.used).slice(0, 12),
      distinctMembers: pick.used.length,
      forwardedWhole: pick.forwardedWhole,
      forwardedTo: pick.forwardedTargets.slice(0, 8),
    },
    repository: {
      callers: findFunctionCallers(owner.filePath, name, projectFiles),
      sameTypeSiblings: sameTypeSiblings.slice(0, 12),
    },
  };
}
