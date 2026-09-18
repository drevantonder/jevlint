import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type {
  ArrowFunctionExpression,
  BlockStatement,
  CallExpression,
  Expression,
  FunctionBody,
  Function as OxcFunction,
  ObjectExpression,
  Program,
  Statement,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  calleeRootName,
  isInsideNestedFunction,
  moduleImports,
  nestedFunctionRanges,
  resolveModule,
} from "./repository.js";
import { parseTestFunction } from "./test-scope.js";

export type MockContractDivergence = {
  kind: "stubbed-but-absent" | "return-key-mismatch" | "mocked-value-never-returned" | "unstubbed-error-path";
  member: string;
  detail: string;
};

export type MockContractTarget = {
  specifier: string;
  resolvedFile: string;
  importedFrom: string | null;
  stubbedMembers: string[];
  absentMembers: string[];
  realReturns: string[];
  realThrows: string[];
  divergences: MockContractDivergence[];
};

export type UnverifiedMockContractEvidence = {
  function: {
    title: string | null;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  mocks: MockContractTarget[];
  divergences: MockContractDivergence[];
  checksComputedValue: boolean;
};

type ModuleMockCall = {
  specifier: string;
  factoryStart: number;
  factoryEnd: number;
};

function quotedInner(raw: string): string | null {
  const quote = raw[0];
  if (quote !== "\"" && quote !== "'" && quote !== "`") return null;
  if (raw.length < 2 || raw[raw.length - 1] !== quote) return null;
  if (quote === "`" && raw.includes("${")) return null;
  return raw.slice(1, -1);
}

function stringArgument(call: CallExpression, source: string): string | null {
  const first = call.arguments[0];
  if (!first || first.type === "SpreadElement" || first.type !== "Literal") return null;
  return quotedInner(source.slice(first.start, first.end));
}

function isModuleMockCall(call: CallExpression, source: string): boolean {
  const root = calleeRootName(call.callee);
  if (root !== "vi" && root !== "vitest" && root !== "jest") return false;
  return /\.\s*(mock|hoisted)\s*\(/.test(source.slice(call.start, call.end));
}

function factoryRange(call: CallExpression): { start: number; end: number } | undefined {
  const second = call.arguments[1];
  if (!second || second.type === "SpreadElement") return undefined;
  const value = second.type === "ChainExpression" ? second.expression : second;
  if (
    value.type !== "ArrowFunctionExpression"
    && value.type !== "FunctionExpression"
  ) return undefined;
  return { start: value.start, end: value.end };
}

function unwrapExpression(expression: Expression): Expression {
  let current = expression;
  while (current.type === "ParenthesizedExpression") {
    current = current.expression;
  }
  return current;
}

function eachDirectStatement(statement: Statement, take: (node: Statement) => void): void {
  if (statement.type === "FunctionDeclaration") return;
  take(statement);
  if (statement.type === "BlockStatement") {
    for (const inner of statement.body) eachDirectStatement(inner, take);
    return;
  }
  if (statement.type === "IfStatement") {
    eachDirectStatement(statement.consequent, take);
    if (statement.alternate) eachDirectStatement(statement.alternate, take);
    return;
  }
  if (statement.type === "TryStatement") {
    for (const inner of statement.block.body) eachDirectStatement(inner, take);
    if (statement.handler) {
      for (const inner of statement.handler.body.body) eachDirectStatement(inner, take);
    }
    if (statement.finalizer) {
      for (const inner of statement.finalizer.body) eachDirectStatement(inner, take);
    }
  }
}

function blockStatements(body: FunctionBody | BlockStatement): Statement[] {
  const result: Statement[] = [];
  for (const item of body.body) result.push(item);
  return result;
}

function factoryObjectBodies(
  program: Program,
  factoryStart: number,
  factoryEnd: number,
): ObjectExpression[] {
  const bodies: ObjectExpression[] = [];
  const takeFn = (fn: ArrowFunctionExpression | OxcFunction): void => {
    if (fn.start !== factoryStart || fn.end !== factoryEnd) return;
    if (!fn.body) return;
    const raw: FunctionBody | Expression = fn.body;
    const body = raw.type === "BlockStatement" ? raw : unwrapExpression(raw);
    if (body.type === "ObjectExpression") {
      bodies.push(body);
      return;
    }
    if (body.type !== "BlockStatement") return;
    for (const statement of blockStatements(body)) {
      eachDirectStatement(statement, (node) => {
        if (node.type === "ReturnStatement" && node.argument?.type === "ObjectExpression") {
          bodies.push(node.argument);
        }
      });
    }
  };
  new Visitor({
    ArrowFunctionExpression: takeFn,
    FunctionExpression: takeFn,
  }).visit(program);
  return bodies;
}

function factoryPropertyName(owner: ProjectFile, object: ObjectExpression, index: number): string | null {
  const property = object.properties[index];
  if (!property || property.type === "SpreadElement" || property.computed) return null;
  const key = property.key;
  if (key.type === "Identifier") return key.name;
  if (key.type === "Literal") return quotedInner(owner.source.slice(key.start, key.end));
  return null;
}

function factoryObjectKeys(
  program: Program,
  owner: ProjectFile,
  factoryStart: number,
  factoryEnd: number,
): string[] {
  const keys: string[] = [];
  for (const body of factoryObjectBodies(program, factoryStart, factoryEnd)) {
    for (let index = 0; index < body.properties.length; index += 1) {
      const name = factoryPropertyName(owner, body, index);
      if (name !== null && !keys.includes(name)) keys.push(name);
    }
  }
  return keys;
}

function mockedValuesInFactory(
  program: Program,
  owner: ProjectFile,
  factoryStart: number,
  factoryEnd: number,
): Array<{ member: string; value: string }> {
  const found: Array<{ member: string; value: string }> = [];
  for (const body of factoryObjectBodies(program, factoryStart, factoryEnd)) {
    for (let index = 0; index < body.properties.length; index += 1) {
      const property = body.properties[index];
      if (!property || property.type === "SpreadElement") continue;
      const name = factoryPropertyName(owner, body, index);
      if (name === null) continue;
      const valueStart = property.value.start;
      const valueEnd = property.value.end;
      new Visitor({
        CallExpression(call) {
          if (call.start < valueStart || call.end > valueEnd) return;
          if (call.callee.type !== "MemberExpression" || call.callee.property.type !== "Identifier") return;
          if (
            call.callee.property.name !== "mockResolvedValue"
            && call.callee.property.name !== "mockReturnValue"
          ) return;
          const first = call.arguments[0];
          if (!first || first.type === "SpreadElement") return;
          found.push({ member: name, value: owner.source.slice(first.start, first.end).slice(0, 200) });
        },
      }).visit(program);
    }
  }
  return found;
}

function exportedNames(program: Program): string[] {
  const names: string[] = [];
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
      ? statement.declaration
      : statement;
    if (!declaration) continue;
    if (
      declaration.type === "FunctionDeclaration"
      || declaration.type === "ClassDeclaration"
    ) {
      if (declaration.id?.name) names.push(declaration.id.name);
      continue;
    }
    if (declaration.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (item.id.type === "Identifier") names.push(item.id.name);
      }
      continue;
    }
    if (
      declaration.type === "TSInterfaceDeclaration"
      || declaration.type === "TSTypeAliasDeclaration"
      || declaration.type === "TSEnumDeclaration"
    ) {
      if (!names.includes(declaration.id.name)) names.push(declaration.id.name);
    }
  }
  for (const statement of program.body) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    for (const specifier of statement.specifiers) {
      const exported = specifier.exported;
      const name = exported.type === "Identifier" ? exported.name : exported.value;
      if (!names.includes(name)) names.push(name);
    }
  }
  return names;
}

function returnObjectKeys(source: string, expression: Expression): string[] {
  const value = expression.type === "ChainExpression" ? expression.expression : expression;
  const unwrapped = unwrapExpression(value);
  if (unwrapped.type === "AwaitExpression") return returnObjectKeys(source, unwrapped.argument);
  if (unwrapped.type !== "ObjectExpression") return [];
  const keys: string[] = [];
  for (const property of unwrapped.properties) {
    if (property.type === "SpreadElement" || property.computed) continue;
    const key = property.key;
    if (key.type === "Identifier") keys.push(key.name);
    else if (key.type === "Literal") {
      const inner = quotedInner(source.slice(key.start, key.end));
      if (inner !== null) keys.push(inner);
    }
  }
  return keys;
}

type RealMemberBehavior = {
  returns: string[];
  returnObjectKeys: string[][];
  hasReturn: boolean;
  throws: string[];
};

function readRealMemberBehavior(program: Program, source: string, member: string): RealMemberBehavior {
  const behavior: RealMemberBehavior = { returns: [], returnObjectKeys: [], hasReturn: false, throws: [] };
  const collect = (body: FunctionBody | BlockStatement | Expression | null): void => {
    if (!body) return;
    if (body.type === "BlockStatement") {
      for (const statement of blockStatements(body)) {
        eachDirectStatement(statement, (node) => {
          if (node.type === "ReturnStatement") {
            if (!node.argument) return;
            behavior.hasReturn = true;
            behavior.returns.push(source.slice(node.argument.start, node.argument.end).slice(0, 200));
            const keys = returnObjectKeys(source, node.argument);
            if (keys.length > 0) behavior.returnObjectKeys.push(keys);
          }
          if (node.type === "ThrowStatement") {
            const text = source.slice(node.argument.start, node.argument.end).slice(0, 200);
            if (!behavior.throws.includes(text)) behavior.throws.push(text);
          }
        });
      }
      return;
    }
    behavior.hasReturn = true;
    behavior.returns.push(source.slice(body.start, body.end).slice(0, 200));
  };
  new Visitor({
    FunctionDeclaration(node) {
      if (node.id?.name !== member || !node.body) return;
      collect(node.body);
    },
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier" || node.id.name !== member) return;
      const init = node.init;
      if (!init) return;
      const fn = init.type === "ChainExpression" ? init.expression : init;
      if (
        fn.type !== "ArrowFunctionExpression"
        && fn.type !== "FunctionExpression"
      ) return;
      collect(fn.body);
    },
  }).visit(program);
  return behavior;
}

function isInteractionAssertion(text: string): boolean {
  return /\btoHaveBeenCalled|\btoHaveBeenNthCalled|\btoHaveBeenCalledTimes|\btoHaveBeenCalledWith|\bcalledOnce\b|\bcalledWith\b/.test(text);
}

function isAssertionLike(text: string): boolean {
  return /\b(expect|assert)\s*[.(]/.test(text);
}

export function buildUnverifiedMockContractEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnverifiedMockContractEvidence | undefined {
  const scope = parseTestFunction(candidate, projectFiles);
  if (!scope) return undefined;
  if (scope.runner !== "it" && scope.runner !== "test") return undefined;
  const { owner, program, fn } = scope;
  const nested = nestedFunctionRanges(program, candidate);

  const mockCalls: ModuleMockCall[] = [];
  const seen = new Set<number>();
  new Visitor({
    CallExpression(call) {
      if (seen.has(call.start)) return;
      if (!isModuleMockCall(call, owner.source)) return;
      seen.add(call.start);
      const specifier = stringArgument(call, owner.source);
      if (!specifier || !specifier.startsWith(".")) return;
      const factory = factoryRange(call);
      mockCalls.push({
        specifier,
        factoryStart: factory?.start ?? call.start,
        factoryEnd: factory?.end ?? call.end,
      });
    },
  }).visit(program);

  if (mockCalls.length === 0) return undefined;

  const imports = moduleImports(program);
  const importedFiles = new Map<string, string>();
  for (const entry of imports) {
    if (!entry.source.startsWith(".")) continue;
    const resolvedImport = resolveModule(owner.filePath, entry.source, projectFiles);
    if (resolvedImport && !importedFiles.has(resolvedImport.filePath)) {
      importedFiles.set(resolvedImport.filePath, entry.source);
    }
  }
  const mocks: MockContractTarget[] = [];
  for (const mock of mockCalls) {
    const resolved = resolveModule(owner.filePath, mock.specifier, projectFiles);
    if (!resolved || resolved.filePath === owner.filePath) continue;
    const importedFrom = importedFiles.get(resolved.filePath) ?? null;
    const parsed = parseCached(resolved.filePath, resolved.source);
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    const exports = exportedNames(parsed.program);

    const stubbed = new Set<string>(
      factoryObjectKeys(program, owner, mock.factoryStart, mock.factoryEnd),
    );
    new Visitor({
      CallExpression(call) {
        if (call.start < mock.factoryStart || call.end > mock.factoryEnd) return;
        if (call.callee.type !== "MemberExpression" || call.callee.property.type !== "Identifier") return;
        if (
          call.callee.property.name !== "mockResolvedValue"
          && call.callee.property.name !== "mockReturnValue"
          && call.callee.property.name !== "mockImplementation"
          && call.callee.property.name !== "mockRejectedValue"
        ) return;
        const object = call.callee.object;
        if (object.type === "Identifier") stubbed.add(object.name);
      },
    }).visit(program);
    new Visitor({
      CallExpression(call) {
        if (call.start < fn.start || call.end > fn.end) return;
        if (isInsideNestedFunction(call, nested)) return;
        const text = owner.source.slice(call.start, call.end);
        const match = /\bspyOn\s*\(\s*[A-Za-z_$][\w$]*\s*,\s*["'`]([^"'`]+)["'`]/.exec(text);
        if (match?.[1]) stubbed.add(match[1]);
      },
    }).visit(program);

    const stubbedMembers = [...stubbed].slice(0, 15);
    const absentMembers = stubbedMembers.filter((name) => !exports.includes(name));
    const divergences: MockContractDivergence[] = absentMembers.map((member) => ({
      kind: "stubbed-but-absent" as const,
      member,
      detail: `Mock stubs "${member}" but ${resolved.filePath} exports no such member`,
    }));

    const realReturns: string[] = [];
    const realThrows: string[] = [];
    const mockedByMember = mockedValuesInFactory(program, owner, mock.factoryStart, mock.factoryEnd);
    for (const member of stubbedMembers.filter((name) => exports.includes(name))) {
      const behavior = readRealMemberBehavior(parsed.program, resolved.source, member);
      for (const text of behavior.returns.slice(0, 3)) {
        realReturns.push(`${member} returns ${text}`.slice(0, 240));
      }
      for (const text of behavior.throws.slice(0, 3)) {
        const entry = `${member} throws ${text}`.slice(0, 240);
        if (!realThrows.includes(entry)) realThrows.push(entry);
      }
      for (const mocked of mockedByMember.filter((entry) => entry.member === member).map((entry) => entry.value)) {
        const mockedKeys = mockedObjectKeys(mocked);
        if (mockedKeys !== null) {
          if (!behavior.hasReturn) {
            divergences.push({
              kind: "mocked-value-never-returned",
              member,
              detail: `Mock resolves ${mocked.slice(0, 120)} but the real ${member} has no return value`,
            });
          } else if (
            behavior.returnObjectKeys.length > 0
            && behavior.returnObjectKeys.every((keys) =>
              !sameKeySet(keys, mockedKeys)
            )
          ) {
            divergences.push({
              kind: "return-key-mismatch",
              member,
              detail: `Mock resolves keys [${mockedKeys.join(", ")}] but the real ${member} returns keys [${behavior.returnObjectKeys.map((keys) => keys.join("+")).join(" | ")}]`,
            });
          }
        }
      }
    }
    const factoryText = owner.source.slice(mock.factoryStart, mock.factoryEnd);
    for (const thrown of realThrows) {
      const message = thrownMessage(thrown);
      if (message !== null && !factoryText.includes(message)) {
        const member = thrown.split(" ")[0] ?? "unknown";
        divergences.push({
          kind: "unstubbed-error-path",
          member,
          detail: `Real module documents ${thrown.slice(0, 160)} but no stub reproduces it`,
        });
      }
    }

    mocks.push({
      specifier: mock.specifier,
      resolvedFile: resolved.filePath,
      importedFrom,
      stubbedMembers,
      absentMembers,
      realReturns: realReturns.slice(0, 8),
      realThrows: realThrows.slice(0, 5),
      divergences: divergences.slice(0, 10),
    });
  }

  if (mocks.length === 0) return undefined;

  let checksComputedValue = false;
  new Visitor({
    CallExpression(call) {
      if (checksComputedValue) return;
      if (call.start < fn.start || call.end > fn.end) return;
      if (isInsideNestedFunction(call, nested)) return;
      const text = owner.source.slice(call.start, call.end);
      if (!isAssertionLike(text) || isInteractionAssertion(text)) return;
      checksComputedValue = true;
    },
  }).visit(program);

  return {
    function: {
      title: scope.title,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    mocks,
    divergences: mocks.flatMap((mock) => mock.divergences).slice(0, 10),
    checksComputedValue,
  };
}

function mockedObjectKeys(mocked: string): string[] | null {
  const trimmed = mocked.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  const keys: string[] = [];
  for (const match of trimmed.matchAll(/(?:^|[{,]\s*)([A-Za-z_$][\w$]*)\s*:/g)) {
    if (match[1]) keys.push(match[1]);
  }
  return keys;
}

function sameKeySet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((name) => right.includes(name));
}

function thrownMessage(thrown: string): string | null {
  const match = /["'`]([^"'`]{3,})["'`]/.exec(thrown);
  return match?.[1] ?? null;
}
