import { parseSync, Visitor } from "oxc-parser";
import type {
  Class,
  Function as OxcFunction,
  MethodDefinition,
  Program,
  PropertyDefinition,
  TSInterfaceDeclaration,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { moduleImports, resolveModule } from "./repository.js";

export type AnemicField = {
  name: string;
  optional: boolean;
  hasInitializer: boolean;
};

export type AnemicMethod = {
  name: string;
  kind: "constructor" | "method" | "get" | "set";
  logic: "empty" | "field-only" | "logic";
};

export type ExternalFieldSite = {
  filePath: string;
  line: number;
  source: string;
  fields: string[];
  branches: boolean;
};

export type AnemicTypeEvidence = {
  abstraction: {
    name: string;
    kind: "class" | "interface";
    filePath: string;
    source: string;
  };
  members: {
    fields: AnemicField[];
    methods: AnemicMethod[];
    accessorOnly: boolean;
  };
  clients: {
    total: number;
    included: number;
    omitted: number;
    sites: ExternalFieldSite[];
  };
  importingModules: string[];
};

function findDeclaration(
  program: Program,
  candidate: Candidate,
): { node: Class; kind: "class" } | { node: TSInterfaceDeclaration; kind: "interface" } | undefined {
  let result: { node: Class; kind: "class" } | { node: TSInterfaceDeclaration; kind: "interface" } | undefined;
  new Visitor({
    ClassDeclaration(node) {
      if (node.start === candidate.start && node.end === candidate.end) {
        result = { node, kind: "class" };
      }
    },
    TSInterfaceDeclaration(node) {
      if (node.start === candidate.start && node.end === candidate.end) {
        result = { node, kind: "interface" };
      }
    },
  }).visit(program);
  return result;
}

function memberName(key: MethodDefinition["key"] | PropertyDefinition["key"]): string | undefined {
  if (key.type === "Identifier" && !("computed" in key && key.computed)) return key.name;
  if (key.type === "PrivateIdentifier") return `#${key.name}`;
  return undefined;
}

function methodDisplayName(definition: MethodDefinition): string {
  if (definition.kind === "constructor") return "constructor";
  return memberName(definition.key) ?? "computed";
}

type FunctionRange = {
  start: number;
  end: number;
};

function inRange(range: FunctionRange, start: number, end: number): boolean {
  return range.start <= start && end <= range.end;
}

function methodLogic(
  value: OxcFunction,
  ownerSource: string,
  program: Program,
): "empty" | "field-only" | "logic" {
  const body = value.body;
  if (!body || (body.type === "BlockStatement" && body.body.length === 0)) return "empty";
  const scope: FunctionRange = { start: value.start, end: value.end };
  const isOwnNode = (start: number, end: number): boolean =>
    start === value.start && end === value.end;
  const nested: FunctionRange[] = [];
  const hits: FunctionRange[] = [];
  const record = (start: number, end: number): void => {
    if (inRange(scope, start, end)) hits.push({ start, end });
  };
  const recordFunction = (start: number, end: number): void => {
    if (inRange(scope, start, end) && !isOwnNode(start, end)) nested.push({ start, end });
  };
  new Visitor({
    ArrowFunctionExpression(node) {
      recordFunction(node.start, node.end);
    },
    FunctionDeclaration(node) {
      recordFunction(node.start, node.end);
    },
    FunctionExpression(node) {
      recordFunction(node.start, node.end);
    },
    CallExpression(node) {
      record(node.start, node.end);
    },
    NewExpression(node) {
      record(node.start, node.end);
    },
    IfStatement(node) {
      record(node.start, node.end);
    },
    ConditionalExpression(node) {
      record(node.start, node.end);
    },
    ForStatement(node) {
      record(node.start, node.end);
    },
    ForInStatement(node) {
      record(node.start, node.end);
    },
    ForOfStatement(node) {
      record(node.start, node.end);
    },
    WhileStatement(node) {
      record(node.start, node.end);
    },
    DoWhileStatement(node) {
      record(node.start, node.end);
    },
    SwitchStatement(node) {
      record(node.start, node.end);
    },
    ThrowStatement(node) {
      record(node.start, node.end);
    },
    TryStatement(node) {
      record(node.start, node.end);
    },
    MemberExpression(node) {
      const text = ownerSource.slice(node.start, node.end);
      if (!text.startsWith("this.") && !text.startsWith("this?.") && !text.startsWith("this[")) {
        record(node.start, node.end);
      }
    },
  }).visit(program);
  const insideNested = (hit: FunctionRange): boolean =>
    nested.some((range) => inRange(range, hit.start, hit.end));
  return hits.some((hit) => !insideNested(hit)) ? "logic" : "field-only";
}

function classifyMethod(
  definition: MethodDefinition,
  ownerSource: string,
  program: Program,
): AnemicMethod {
  return {
    name: methodDisplayName(definition),
    kind: definition.kind,
    logic: methodLogic(definition.value, ownerSource, program),
  };
}

function classMembers(node: Class, ownerSource: string, program: Program) {
  const fields: AnemicField[] = [];
  const methods: AnemicMethod[] = [];
  for (const element of node.body.body) {
    if (element.type === "MethodDefinition") {
      if (element.kind === "constructor") continue;
      methods.push(classifyMethod(element, ownerSource, program));
      continue;
    }
    if (element.type === "PropertyDefinition") {
      if (element.static) continue;
      const name = memberName(element.key);
      if (!name) continue;
      fields.push({
        name,
        optional: element.optional === true,
        hasInitializer: element.value !== null,
      });
    }
  }
  return { fields, methods };
}

function interfaceMembers(node: TSInterfaceDeclaration) {
  const fields: AnemicField[] = [];
  const methods: AnemicMethod[] = [];
  for (const member of node.body.body) {
    if (member.type === "TSPropertySignature") {
      if (member.computed || member.key.type !== "Identifier") continue;
      fields.push({
        name: member.key.name,
        optional: member.optional === true,
        hasInitializer: false,
      });
      continue;
    }
    if (member.type === "TSMethodSignature") {
      if (member.computed || member.key.type !== "Identifier") continue;
      methods.push({ name: member.key.name, kind: "method", logic: "logic" });
    }
  }
  return { fields, methods };
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function importsType(
  program: Program,
  filePath: string,
  ownerPath: string,
  typeName: string,
  projectFiles: ProjectFile[],
): boolean {
  if (filePath === ownerPath) return true;
  return moduleImports(program).some((imported) =>
    imported.imported === typeName
    && resolveModule(filePath, imported.source, projectFiles)?.filePath === ownerPath
  );
}

function findClientSites(
  ownerPath: string,
  typeName: string,
  fieldNames: string[],
  projectFiles: ProjectFile[],
) {
  const sites: ExternalFieldSite[] = [];
  const importingModules = new Set<string>();
  const fieldPattern = fieldNames.length > 0
    ? new RegExp(`\\.\\s*(${fieldNames.map(escapeRegExp).join("|")})\\b`)
    : null;
  for (const file of projectFiles) {
    if (file.filePath === ownerPath) continue;
    const parsed = parseSync(file.filePath, file.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    if (!importsType(parsed.program, file.filePath, ownerPath, typeName, projectFiles)) continue;
    importingModules.add(file.filePath);
    if (!fieldPattern) continue;
    const branchTests: Array<{ start: number; end: number }> = [];
    new Visitor({
      IfStatement(node) {
        branchTests.push({ start: node.test.start, end: node.test.end });
      },
      ConditionalExpression(node) {
        branchTests.push({ start: node.test.start, end: node.test.end });
      },
      SwitchStatement(node) {
        branchTests.push({ start: node.discriminant.start, end: node.discriminant.end });
      },
      MemberExpression(node) {
        const text = file.source.slice(node.start, node.end);
        if (!fieldPattern.test(text)) return;
        const fields = fieldNames.filter((name) => new RegExp(`\\.\\s*${escapeRegExp(name)}\\b`).test(text));
        sites.push({
          filePath: file.filePath,
          line: lineAt(file.source, node.start),
          source: text.slice(0, 300),
          fields,
          branches: branchTests.some((test) => test.start <= node.start && node.end <= test.end),
        });
      },
    }).visit(parsed.program);
  }
  const total = sites.length;
  return {
    sites: sites.slice(0, 20),
    total,
    importingModules: [...importingModules].sort().slice(0, 12),
  };
}

export function buildAnemicTypeEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): AnemicTypeEvidence | undefined {
  if (candidate.kind !== "abstraction") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const declaration = findDeclaration(parsed.program, candidate);
  if (!declaration) return undefined;

  const name = declaration.node.id?.name;
  if (!name) return undefined;
  const members = declaration.kind === "class"
    ? classMembers(declaration.node, owner.source, parsed.program)
    : interfaceMembers(declaration.node);
  if (members.fields.length === 0 && members.methods.length === 0) return undefined;

  const fieldNames = members.fields.map(({ name: field }) => field);
  const { sites, total, importingModules } = findClientSites(
    owner.filePath,
    name,
    fieldNames,
    projectFiles,
  );
  const logicMethods = members.methods.filter(({ logic }) => logic === "logic");

  return {
    abstraction: {
      name,
      kind: declaration.kind,
      filePath: owner.filePath,
      source: candidate.source,
    },
    members: {
      fields: members.fields,
      methods: members.methods,
      accessorOnly: members.methods.length > 0
        && logicMethods.length === 0
        && members.methods.every(({ kind }) => kind === "get" || kind === "set"),
    },
    clients: {
      total,
      included: sites.length,
      omitted: total - sites.length,
      sites,
    },
    importingModules,
  };
}
