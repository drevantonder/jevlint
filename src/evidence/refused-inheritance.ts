import { parseSync, Visitor } from "oxc-parser";
import type { Class, Expression, Program, Statement } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { moduleImports, resolveModule } from "./repository.js";

const MAX_OVERRIDES = 12;
const MAX_UNUSED_INHERITED = 20;
const MAX_INSTANTIATIONS = 8;
const MAX_SUPERTYPE_USAGES = 8;
const MAX_SNIPPET_CHARS = 240;

type OverrideBodyKind =
  | "throws"
  | "constant-return"
  | "empty"
  | "super-delegating"
  | "specializing";

type OverrideEvidence = {
  name: string;
  bodyKind: OverrideBodyKind;
  source: string;
};

type UsageEvidence = {
  filePath: string;
  line: number;
  snippet: string;
};

export type RefusedInheritanceEvidence = {
  subclass: {
    name: string;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  superclass: {
    name: string;
    ownership: "same-module" | "project-module";
    filePath: string;
    members: string[];
  };
  overrides: OverrideEvidence[];
  unusedInherited: string[];
  instantiations: UsageEvidence[];
  supertypeUsages: UsageEvidence[];
};

function findClass(program: Program, candidate: Candidate): Class | undefined {
  let result: Class | undefined;
  new Visitor({
    ClassDeclaration(node) {
      if (node.start === candidate.start && node.end === candidate.end) result = node;
    },
  }).visit(program);
  return result;
}

function memberName(member: Class["body"]["body"][number]): string | undefined {
  if (member.type !== "MethodDefinition" && member.type !== "PropertyDefinition") return undefined;
  const key = member.key;
  if (key.type === "Identifier") return key.name;
  if (key.type === "PrivateIdentifier") return `#${key.name}`;
  return undefined;
}

function superclassMembers(node: Class): string[] {
  const members = new Set<string>();
  for (const member of node.body.body) {
    if (member.type !== "MethodDefinition") continue;
    const name = memberName(member);
    if (!name || name === "constructor" || name.startsWith("#")) continue;
    members.add(name);
  }
  return [...members].sort((left, right) => left.localeCompare(right));
}

function definedClass(
  file: ProjectFile,
  className: string,
): Class | undefined {
  const parsed = parseSync(file.filePath, file.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  let found: Class | undefined;
  new Visitor({
    ClassDeclaration(node) {
      if (node.id?.name === className) found = node;
    },
  }).visit(parsed.program);
  return found;
}

function defaultExportedClass(file: ProjectFile): Class | undefined {
  const parsed = parseSync(file.filePath, file.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  let found: Class | undefined;
  for (const statement of parsed.program.body) {
    if (statement.type !== "ExportDefaultDeclaration") continue;
    if (statement.declaration?.type === "ClassDeclaration") found = statement.declaration;
  }
  return found;
}

function findSuperclass(
  owner: ProjectFile,
  superName: string,
  projectFiles: ProjectFile[],
): { file: ProjectFile; node: Class } | undefined {
  const local = definedClass(owner, superName);
  if (local) return { file: owner, node: local };
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  for (const imported of moduleImports(parsed.program)) {
    if (imported.local !== superName) continue;
    const target = resolveModule(owner.filePath, imported.source, projectFiles);
    if (!target) continue;
    if (imported.imported === "default") {
      const byName = definedClass(target, superName);
      if (byName) return { file: target, node: byName };
      const defaulted = defaultExportedClass(target);
      if (defaulted) return { file: target, node: defaulted };
    } else if (imported.imported !== "*") {
      const remote = definedClass(target, imported.imported);
      if (remote) return { file: target, node: remote };
    }
  }
  return undefined;
}

function statementsOf(body: { body: Statement[] } | null): Statement[] {
  return body?.body ?? [];
}

function isConstantReturn(argument: Expression | null | undefined): boolean {
  if (!argument) return false;
  return argument.type === "Literal"
    || argument.type === "TemplateLiteral"
    || argument.type === "Identifier"
    && /^(?:null|undefined|true|false|NaN)$/.test(argument.name);
}

function containsThrow(statements: Statement[]): boolean {
  return statements.some((statement) => {
    if (statement.type === "ThrowStatement") return true;
    if (statement.type === "BlockStatement") return containsThrow(statement.body);
    if (statement.type === "IfStatement") {
      const branches = [statement.consequent, statement.alternate].filter(
        (branch): branch is Statement => branch !== null && branch !== undefined,
      );
      return branches.some((branch) =>
        branch.type === "BlockStatement" ? containsThrow(branch.body) : branch.type === "ThrowStatement"
      );
    }
    return false;
  });
}

function callsSuper(statements: Statement[]): boolean {
  return statements.some((statement) => {
    if (
      statement.type === "ExpressionStatement"
      && statement.expression.type === "CallExpression"
      && statement.expression.callee.type === "MemberExpression"
      && statement.expression.callee.object.type === "Super"
    ) return true;
    if (
      statement.type === "ReturnStatement"
      && statement.argument?.type === "CallExpression"
      && statement.argument.callee.type === "MemberExpression"
      && statement.argument.callee.object.type === "Super"
    ) return true;
    return false;
  });
}

function classifyOverride(
  member: Class["body"]["body"][number],
  source: string,
): OverrideEvidence | undefined {
  if (member.type !== "MethodDefinition") return undefined;
  if (member.kind === "constructor") return undefined;
  const name = memberName(member);
  if (!name || member.value.type !== "FunctionExpression") return undefined;
  const statements = statementsOf(member.value.body);
  const body = source.slice(member.start, member.end).slice(0, 1_200);
  if (statements.length === 0) return { name, bodyKind: "empty", source: body };
  if (containsThrow(statements)) return { name, bodyKind: "throws", source: body };
  if (
    statements.length === 1
    && statements[0]?.type === "ReturnStatement"
    && isConstantReturn(statements[0].argument)
  ) return { name, bodyKind: "constant-return", source: body };
  if (callsSuper(statements)) return { name, bodyKind: "super-delegating", source: body };
  return { name, bodyKind: "specializing", source: body };
}

function referencedThisMembers(program: Program, node: Class): Set<string> {
  const names = new Set<string>();
  new Visitor({
    MemberExpression(expression) {
      if (expression.start < node.start || expression.end > node.end) return;
      if (expression.object.type !== "ThisExpression" && expression.object.type !== "Super") return;
      if (expression.property.type === "Identifier" && !expression.computed) {
        names.add(expression.property.name);
      }
    },
  }).visit(program);
  return names;
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function instantiations(
  subclassName: string,
  projectFiles: ProjectFile[],
): UsageEvidence[] {
  const result: UsageEvidence[] = [];
  for (const file of projectFiles) {
    const parsed = parseSync(file.filePath, file.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    new Visitor({
      NewExpression(node) {
        if (node.callee.type !== "Identifier" || node.callee.name !== subclassName) return;
        if (result.length < MAX_INSTANTIATIONS) {
          result.push({
            filePath: file.filePath,
            line: lineAt(file.source, node.start),
            snippet: file.source.slice(node.start, node.end).slice(0, MAX_SNIPPET_CHARS),
          });
        }
      },
    }).visit(parsed.program);
    if (result.length >= MAX_INSTANTIATIONS) break;
  }
  return result;
}

function supertypeUsages(
  superName: string,
  projectFiles: ProjectFile[],
): UsageEvidence[] {
  const result: UsageEvidence[] = [];
  for (const file of projectFiles) {
    const parsed = parseSync(file.filePath, file.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    new Visitor({
      TSTypeReference(node) {
        if (node.typeName.type !== "Identifier" || node.typeName.name !== superName) return;
        if (result.length < MAX_SUPERTYPE_USAGES) {
          result.push({
            filePath: file.filePath,
            line: lineAt(file.source, node.start),
            snippet: file.source.slice(Math.max(0, node.start - 80), node.end + 40)
              .replaceAll(/\s+/g, " ").trim().slice(0, MAX_SNIPPET_CHARS),
          });
        }
      },
    }).visit(parsed.program);
    if (result.length >= MAX_SUPERTYPE_USAGES) break;
  }
  return result;
}

export function buildRefusedInheritanceEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): RefusedInheritanceEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const node = findClass(parsed.program, candidate);
  if (!node) return undefined;
  const name = node.id?.name;
  if (!name) return undefined;
  if (node.superClass?.type !== "Identifier") return undefined;
  const superName = node.superClass.name;

  const resolved = findSuperclass(owner, superName, projectFiles);
  if (!resolved) return undefined;
  const inherited = superclassMembers(resolved.node);
  if (inherited.length === 0) return undefined;

  const subclassMemberNames = new Set(
    node.body.body.flatMap((member) => {
      const memberNameValue = memberName(member);
      return memberNameValue === undefined ? [] : [memberNameValue];
    }),
  );
  const overrides = node.body.body.flatMap((member) => {
    const override = classifyOverride(member, owner.source);
    if (!override || !inherited.includes(override.name)) return [];
    return [override];
  }).slice(0, MAX_OVERRIDES);
  const referenced = referencedThisMembers(parsed.program, node);
  const unusedInherited = inherited
    .filter((member) => !subclassMemberNames.has(member) && !referenced.has(member))
    .slice(0, MAX_UNUSED_INHERITED);
  if (overrides.length === 0 && unusedInherited.length === 0) return undefined;

  return {
    subclass: {
      name,
      filePath: owner.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    superclass: {
      name: superName,
      ownership: resolved.file.filePath === owner.filePath ? "same-module" : "project-module",
      filePath: resolved.file.filePath,
      members: inherited,
    },
    overrides,
    unusedInherited,
    instantiations: instantiations(name, projectFiles),
    supertypeUsages: supertypeUsages(superName, projectFiles),
  };
}
