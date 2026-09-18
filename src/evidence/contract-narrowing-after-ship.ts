import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { Expression, Program } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { findFunctionCallers } from "./repository.js";
import type { FunctionNode } from "./repository.js";

const MAX_NARROWINGS = 10;
const MAX_CALLERS_PER_NARROWING = 4;
const MAX_EXCERPT_CHARS = 400;

export type NarrowingKind = "required-property" | "new-throw-guard" | "non-null-assertion";

export type ContractNarrowing = {
  filePath: string;
  kind: NarrowingKind;
  target: string;
  line: number;
  before: string;
  after: string;
};

export type AffectedCaller = {
  filePath: string;
  line: number;
  call: string;
  target: string;
  omitsNarrowedInput: boolean;
};

export type ContractNarrowingEvidence = {
  anchorFile: string;
  coverage: {
    totalFiles: number;
    comparedFiles: number;
  };
  narrowings: ContractNarrowing[];
  affectedCallers: AffectedCaller[];
};

type TypeMember = {
  optional: boolean;
  line: number;
  excerpt: string;
};

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function changedLineSet(change: SourceFile): Set<number> {
  const lines = new Set<number>();
  for (const range of change.changedLines) {
    for (let line = range.start; line <= range.end; line += 1) lines.add(line);
  }
  return lines;
}

function memberKeyText(key: { type: string; start: number; end: number }, source: string): string {
  return source.slice(key.start, key.end).replace(/^["']|["']$/g, "");
}

function typeMembers(program: Program, source: string): Map<string, TypeMember> {
  const members = new Map<string, TypeMember>();
  const record = (
    typeName: string,
    key: string,
    optional: boolean,
    start: number,
    end: number,
  ): void => {
    members.set(`${typeName}.${key}`, {
      optional,
      line: lineAt(source, start),
      excerpt: source.slice(start, end).slice(0, MAX_EXCERPT_CHARS),
    });
  };
  new Visitor({
    TSInterfaceDeclaration(node) {
      const name = node.id.name;
      for (const member of node.body.body) {
        if (member.type !== "TSPropertySignature") continue;
        const key = member.key;
        if (key.type !== "Identifier" && key.type !== "Literal") continue;
        record(name, memberKeyText(key, source), member.optional, member.start, member.end);
      }
    },
    TSTypeAliasDeclaration(node) {
      const annotation = node.typeAnnotation;
      if (annotation.type !== "TSTypeLiteral") return;
      const name = node.id.name;
      for (const member of annotation.members) {
        if (member.type !== "TSPropertySignature") continue;
        const key = member.key;
        if (key.type !== "Identifier" && key.type !== "Literal") continue;
        record(name, memberKeyText(key, source), member.optional, member.start, member.end);
      }
    },
  }).visit(program);
  return members;
}

type FunctionScope = {
  node: FunctionNode;
  name: string;
  params: string[];
};

function functionScopes(program: Program): FunctionScope[] {
  const scopes: FunctionScope[] = [];
  const paramNames = (node: FunctionNode): string[] => {
    const names: string[] = [];
    for (const parameter of node.params) {
      const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
      if (value.type === "Identifier") names.push(value.name);
      else if (value.type === "AssignmentPattern" && value.left.type === "Identifier") {
        names.push(value.left.name);
      } else if (value.type === "ObjectPattern") {
        for (const property of value.properties) {
          if (
            property.type === "Property"
            && property.value.type === "Identifier"
          ) names.push(property.value.name);
        }
      }
    }
    return names;
  };
  new Visitor({
    FunctionDeclaration(node) {
      if (node.id) {
        scopes.push({
          node,
          name: node.id.name,
          params: paramNames(node),
        });
      }
    },
  }).visit(program);
  return scopes;
}

function variableFunctionScopes(program: Program): FunctionScope[] {
  const scopes: FunctionScope[] = [];
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (declaration?.type !== "VariableDeclaration") continue;
    for (const item of declaration.declarations) {
      if (item.id.type !== "Identifier" || !item.init) continue;
      if (
        item.init.type !== "ArrowFunctionExpression"
        && item.init.type !== "FunctionExpression"
      ) continue;
      const params: string[] = [];
      for (const parameter of item.init.params) {
        if (parameter.type === "Identifier") params.push(parameter.name);
        else if (
          parameter.type === "AssignmentPattern" && parameter.left.type === "Identifier"
        ) params.push(parameter.left.name);
      }
      scopes.push({ node: item.init, name: item.id.name, params });
    }
  }
  return scopes;
}

function rootName(expression: Expression): string | undefined {
  if (expression.type === "Identifier") return expression.name;
  if (expression.type === "MemberExpression") {
    return expression.object.type === "Super" ? undefined : rootName(expression.object);
  }
  if (expression.type === "ChainExpression") return rootName(expression.expression);
  if (
    expression.type === "TSAsExpression"
    || expression.type === "TSNonNullExpression"
    || expression.type === "TSSatisfiesExpression"
  ) return rootName(expression.expression);
  return undefined;
}

function identifiersIn(source: string, start: number, end: number): Set<string> {
  const names = new Set<string>();
  for (const match of source.slice(start, end).matchAll(/[A-Za-z_$][\w$]*/g)) {
    names.add(match[0]);
  }
  return names;
}

export function buildContractNarrowingEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): ContractNarrowingEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  if (changes.length === 0) return undefined;

  const narrowings: ContractNarrowing[] = [];
  let compared = 0;

  const ordered = [...changes].sort((left, right) => {
    if (left.filePath === candidate.filePath) return -1;
    if (right.filePath === candidate.filePath) return 1;
    return left.filePath.localeCompare(right.filePath);
  });

  for (const change of ordered) {
    if (narrowings.length >= MAX_NARROWINGS) break;
    if (change.oldSource === null) continue;
    const oldSource: string = change.oldSource;
    const beforeParsed = parseCached(change.filePath, oldSource);
    const afterParsed = parseCached(change.filePath, change.source);
    if (
      beforeParsed.errors.some((error) => error.severity === "Error")
      || afterParsed.errors.some((error) => error.severity === "Error")
    ) continue;
    compared += 1;
    const changed = changedLineSet(change);
    const source = change.source;

    const beforeMembers = typeMembers(beforeParsed.program, oldSource);
    const afterMembers = typeMembers(afterParsed.program, source);
    for (const [key, after] of afterMembers) {
      if (narrowings.length >= MAX_NARROWINGS) break;
      if (after.optional) continue;
      const before = beforeMembers.get(key);
      if (before && !before.optional) continue;
      if (!changed.has(after.line)) continue;
      narrowings.push({
        filePath: change.filePath,
        kind: "required-property",
        target: key,
        line: after.line,
        before: before?.excerpt ?? "(absent)",
        after: after.excerpt,
      });
    }

    const scopes = [...functionScopes(afterParsed.program), ...variableFunctionScopes(afterParsed.program)];
    const beforeThrows = new Set<string>();
    new Visitor({
      ThrowStatement(node) {
        beforeThrows.add(oldSource.slice(node.start, node.end).trim().slice(0, 200));
      },
    }).visit(beforeParsed.program);

    for (const scope of scopes) {
      if (narrowings.length >= MAX_NARROWINGS) break;
      new Visitor({
        IfStatement(node) {
          if (narrowings.length >= MAX_NARROWINGS) return;
          if (node.start < scope.node.start || node.end > scope.node.end) return;
          const consequentText = source.slice(node.consequent.start, node.consequent.end);
          if (!/\bthrow\b/.test(consequentText)) return;
          const throwLine = lineAt(source, node.start);
          if (!changed.has(throwLine)) return;
          const guard = source.slice(node.test.start, node.test.end);
          const guardNames = identifiersIn(source, node.test.start, node.test.end);
          if (!scope.params.some((param) => guardNames.has(param))) return;
          const throwText = consequentText.trim().slice(0, 200);
          if (beforeThrows.has(throwText)) return;
          narrowings.push({
            filePath: change.filePath,
            kind: "new-throw-guard",
            target: `${scope.name} guarded by ${guard.slice(0, 120)}`,
            line: throwLine,
            before: "(accepted)",
            after: `if (${guard.slice(0, 160)}) ${consequentText.trim().slice(0, 160)}`,
          });
        },
        ThrowStatement(node) {
          if (narrowings.length >= MAX_NARROWINGS) return;
          if (node.start < scope.node.start || node.end > scope.node.end) return;
          const throwLine = lineAt(source, node.start);
          if (!changed.has(throwLine)) return;
          const throwText = source.slice(node.start, node.end).trim().slice(0, 200);
          if (beforeThrows.has(throwText)) return;
          if (narrowings.some((existing) => existing.after.includes(throwText))) return;
          narrowings.push({
            filePath: change.filePath,
            kind: "new-throw-guard",
            target: scope.name,
            line: throwLine,
            before: "(accepted)",
            after: throwText,
          });
        },
        TSNonNullExpression(node) {
          if (narrowings.length >= MAX_NARROWINGS) return;
          if (node.start < scope.node.start || node.end > scope.node.end) return;
          const line = lineAt(source, node.start);
          if (!changed.has(line)) return;
          const root = rootName(node.expression);
          if (!root || !scope.params.includes(root)) return;
          const text = source.slice(node.start, node.end);
          if (oldSource.includes(text)) return;
          narrowings.push({
            filePath: change.filePath,
            kind: "non-null-assertion",
            target: `${scope.name}(${root})`,
            line,
            before: root,
            after: text.slice(0, MAX_EXCERPT_CHARS),
          });
        },
      }).visit(afterParsed.program);
    }
  }

  if (narrowings.length === 0) return undefined;

  const affectedCallers: AffectedCaller[] = [];
  for (const narrowing of narrowings) {
    const candidates: { fn: string; keyHint: string | null }[] = [];
    if (narrowing.kind === "required-property") {
      const [typeName, prop] = narrowing.target.split(".");
      for (const file of projectFiles) {
        if (file.filePath !== narrowing.filePath) continue;
        const parsed = parseCached(file.filePath, file.source);
        if (parsed.errors.some((error) => error.severity === "Error")) continue;
        for (const scope of [...functionScopes(parsed.program), ...variableFunctionScopes(parsed.program)]) {
          const scopeText = file.source.slice(scope.node.start, scope.node.end);
          if (new RegExp(`:\\s*${typeName}\\b`).test(scopeText)) {
            candidates.push({ fn: scope.name, keyHint: prop ?? null });
          }
        }
      }
    } else if (narrowing.kind === "new-throw-guard") {
      const fn = narrowing.target.split(" guarded by ")[0] ?? narrowing.target;
      const guard = narrowing.target.includes("guarded by")
        ? narrowing.after.slice(4, narrowing.after.indexOf(")"))
        : null;
      candidates.push({ fn, keyHint: guard });
    } else {
      const fn = narrowing.target.split("(")[0] ?? narrowing.target;
      candidates.push({ fn, keyHint: null });
    }
    for (const { fn, keyHint } of candidates) {
      if (!fn) continue;
      const callers = findFunctionCallers(narrowing.filePath, fn, projectFiles)
        .slice(0, MAX_CALLERS_PER_NARROWING);
      for (const caller of callers) {
        const argsText = caller.arguments.join(", ");
        let omits = false;
        if (narrowing.kind === "required-property" && keyHint) {
          omits = !new RegExp(`\\b${keyHint}\\b`).test(argsText);
        } else if (narrowing.kind === "non-null-assertion") {
          omits = /\bnull\b|\bundefined\b/.test(argsText);
        } else if (keyHint) {
          const keys = keyHint.match(/[A-Za-z_$][\w$]*/g) ?? [];
          const propNames = keys.filter((key) => key !== fn && !["if", "throw"].includes(key));
          const last = propNames[propNames.length - 1];
          omits = last ? !new RegExp(`\\b${last}\\b`).test(argsText) : false;
        }
        affectedCallers.push({
          filePath: caller.filePath,
          line: caller.line,
          call: caller.call.slice(0, MAX_EXCERPT_CHARS),
          target: fn,
          omitsNarrowedInput: omits,
        });
      }
    }
  }

  return {
    anchorFile: candidate.filePath,
    coverage: { totalFiles: changes.length, comparedFiles: compared },
    narrowings,
    affectedCallers,
  };
}
