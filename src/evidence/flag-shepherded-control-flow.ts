import { parseSync, Visitor } from "oxc-parser";
import type { Expression } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type ShepherdTestKind = "if" | "while" | "do-while" | "for" | "conditional";

export type ShepherdTestRead = {
  kind: ShepherdTestKind;
  line: number;
  test: string;
};

export type ShepherdFlag = {
  name: string;
  line: number;
  initKind: "boolean" | "nullish" | "none";
  writes: Array<{ line: number }>;
  testReads: ShepherdTestRead[];
  returned: boolean;
  passedAsArgument: boolean;
  capturedByNested: boolean;
  dataReads: number;
  writeToBranchLines: number | null;
};

export type FlagShepherdedControlFlowEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  flags: ShepherdFlag[];
  escapedFlags: string[];
  callers: FunctionCaller[];
};

type Range = { start: number; end: number };

const COMPARISON_OPERATORS = new Set([
  "==",
  "!=",
  "===",
  "!==",
  "<",
  "<=",
  ">",
  ">=",
  "in",
  "instanceof",
]);

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

type MutableFlag = ShepherdFlag & { start: number; end: number };

function initKindOf(init: Expression | null | undefined): "boolean" | "nullish" | "none" | "other" {
  if (!init) return "none";
  if (init.type === "Literal") {
    if (init.value === true || init.value === false) return "boolean";
    if (init.value === null) return "nullish";
    return "other";
  }
  if (init.type === "Identifier" && init.name === "undefined") return "nullish";
  if (init.type === "UnaryExpression" && init.operator === "!") return "boolean";
  if (init.type === "UnaryExpression" && init.operator === "void") return "nullish";
  if (init.type === "BinaryExpression" && COMPARISON_OPERATORS.has(init.operator)) {
    return "boolean";
  }
  if (init.type === "LogicalExpression") {
    return init.operator === "??" ? "nullish" : "boolean";
  }
  return "other";
}

export function buildFlagShepherdedControlFlowEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): FlagShepherdedControlFlowEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const nested = nestedFunctionRanges(parsed.program, candidate);
  const inScope = (node: Range): boolean =>
    node.start >= candidate.start && node.end <= candidate.end;
  const inNested = (node: Range): boolean =>
    nested.some((range) => range.start <= node.start && range.end >= node.end);
  const eligible = (node: Range): boolean => inScope(node) && !inNested(node);

  const flags = new Map<string, MutableFlag>();

  new Visitor({
    VariableDeclaration(node) {
      if (node.kind !== "let" && node.kind !== "var") return;
      for (const declaration of node.declarations) {
        if (declaration.id.type !== "Identifier" || !eligible(declaration)) continue;
        const kind = initKindOf(declaration.init);
        if (kind === "other") continue;
        const flagName = declaration.id.name;
        if (flags.has(flagName)) continue;
        flags.set(flagName, {
          name: flagName,
          line: lineAt(owner.source, declaration.start),
          initKind: kind,
          writes: [],
          testReads: [],
          returned: false,
          passedAsArgument: false,
          capturedByNested: false,
          dataReads: 0,
          writeToBranchLines: null,
          start: declaration.start,
          end: declaration.end,
        });
      }
    },
  }).visit(parsed.program);

  if (flags.size === 0) return undefined;

  const tests: Array<{ kind: ShepherdTestKind; start: number; end: number; text: string }> = [];
  const returnArgs: Range[] = [];
  const callArgs: Range[] = [];
  const writeTargets: Range[] = [];
  const writeSpans: Range[] = [];

  const inside = (ranges: Range[], node: Range): boolean =>
    ranges.some((range) => range.start <= node.start && range.end >= node.end);

  const recordWrite = (flagName: string, node: Range): void => {
    const flag = flags.get(flagName);
    if (flag && eligible(node)) flag.writes.push({ line: lineAt(owner.source, node.start) });
  };

  new Visitor({
    IfStatement(node) {
      if (!eligible(node.test)) return;
      tests.push({
        kind: "if",
        start: node.test.start,
        end: node.test.end,
        text: owner.source.slice(node.test.start, node.test.end).replace(/\s+/g, " ").trim(),
      });
    },
    "IfStatement:exit"(node) {
      if (!eligible(node.test)) return;
      tests.pop();
    },
    WhileStatement(node) {
      if (!eligible(node.test)) return;
      tests.push({
        kind: "while",
        start: node.test.start,
        end: node.test.end,
        text: owner.source.slice(node.test.start, node.test.end).replace(/\s+/g, " ").trim(),
      });
    },
    "WhileStatement:exit"(node) {
      if (!eligible(node.test)) return;
      tests.pop();
    },
    DoWhileStatement(node) {
      if (!eligible(node.test)) return;
      tests.push({
        kind: "do-while",
        start: node.test.start,
        end: node.test.end,
        text: owner.source.slice(node.test.start, node.test.end).replace(/\s+/g, " ").trim(),
      });
    },
    "DoWhileStatement:exit"(node) {
      if (!eligible(node.test)) return;
      tests.pop();
    },
    ForStatement(node) {
      if (!node.test || !eligible(node.test)) return;
      tests.push({
        kind: "for",
        start: node.test.start,
        end: node.test.end,
        text: owner.source.slice(node.test.start, node.test.end).replace(/\s+/g, " ").trim(),
      });
    },
    "ForStatement:exit"(node) {
      if (!node.test || !eligible(node.test)) return;
      tests.pop();
    },
    ConditionalExpression(node) {
      if (!eligible(node.test)) return;
      tests.push({
        kind: "conditional",
        start: node.test.start,
        end: node.test.end,
        text: owner.source.slice(node.test.start, node.test.end).replace(/\s+/g, " ").trim(),
      });
    },
    "ConditionalExpression:exit"(node) {
      if (!eligible(node.test)) return;
      tests.pop();
    },
    ReturnStatement(node) {
      if (node.argument && eligible(node.argument)) returnArgs.push(node.argument);
    },
    "ReturnStatement:exit"(node) {
      if (node.argument && eligible(node.argument)) returnArgs.pop();
    },
    CallExpression(node) {
      for (const argument of node.arguments) {
        if (argument.type === "SpreadElement") continue;
        if (eligible(argument)) callArgs.push(argument);
      }
    },
    "CallExpression:exit"(node) {
      for (const argument of node.arguments) {
        if (argument.type === "SpreadElement") continue;
        if (eligible(argument)) callArgs.pop();
      }
    },
    AssignmentExpression(node) {
      if (!inScope(node) || inNested(node)) return;
      writeSpans.push(node);
      if (node.left.type === "Identifier") {
        writeTargets.push(node.left);
        recordWrite(node.left.name, node.left);
      }
    },
    "AssignmentExpression:exit"(node) {
      if (!inScope(node) || inNested(node)) return;
      writeSpans.pop();
      if (node.left.type === "Identifier") writeTargets.pop();
    },
    VariableDeclarator(node) {
      if (node.id.type === "Identifier" && eligible(node.id)) writeTargets.push(node.id);
    },
    "VariableDeclarator:exit"(node) {
      if (node.id.type === "Identifier" && eligible(node.id)) writeTargets.pop();
    },
    UpdateExpression(node) {
      if (!inScope(node) || inNested(node)) return;
      writeSpans.push(node);
      if (node.argument.type === "Identifier") {
        writeTargets.push(node.argument);
        recordWrite(node.argument.name, node.argument);
      }
    },
    "UpdateExpression:exit"(node) {
      if (!inScope(node) || inNested(node)) return;
      writeSpans.pop();
      if (node.argument.type === "Identifier") writeTargets.pop();
    },
    Identifier(node) {
      const flag = flags.get(node.name);
      if (!flag || !inScope(node)) return;
      const text = owner.source;
      if (text[node.start - 1] === ".") return;
      if (inNested(node)) {
        flag.capturedByNested = true;
        return;
      }
      const enclosingTest = tests.find((test) => test.start <= node.start && test.end >= node.end);
      if (enclosingTest) {
        flag.testReads.push({
          kind: enclosingTest.kind,
          line: lineAt(text, node.start),
          test: enclosingTest.text,
        });
        return;
      }
      if (inside(writeTargets, node)) return;
      if (inside(returnArgs, node)) {
        flag.returned = true;
        return;
      }
      if (inside(callArgs, node)) {
        flag.passedAsArgument = true;
        return;
      }
      if (inside(writeSpans, node)) return;
      let next = node.end;
      while (next < text.length && /\s/.test(text[next] ?? "")) next += 1;
      let previous = node.start - 1;
      while (previous >= 0 && /\s/.test(text[previous] ?? "")) previous -= 1;
      if ((text[next] === ":") && (text[previous] === "{" || text[previous] === ",")) return;
      flag.dataReads += 1;
    },
  }).visit(parsed.program);

  const keepers: ShepherdFlag[] = [];
  const escaped: string[] = [];
  for (const flag of flags.values()) {
    const escapedFlag = flag.returned || flag.passedAsArgument || flag.capturedByNested || flag.dataReads > 0;
    if (flag.testReads.length === 0 || escapedFlag) {
      if (flag.testReads.length > 0) escaped.push(flag.name);
      continue;
    }
    const writeLines = [flag.line, ...flag.writes.map((write) => write.line)].sort((a, b) => a - b);
    const firstRead = [...flag.testReads].sort((a, b) => a.line - b.line)[0];
    const preceding = firstRead ? writeLines.filter((line) => line <= firstRead.line) : [];
    keepers.push({
      name: flag.name,
      line: flag.line,
      initKind: flag.initKind,
      writes: flag.writes.slice(0, 10),
      testReads: flag.testReads.slice(0, 10),
      returned: flag.returned,
      passedAsArgument: flag.passedAsArgument,
      capturedByNested: flag.capturedByNested,
      dataReads: flag.dataReads,
      writeToBranchLines: firstRead && preceding.length > 0
        ? firstRead.line - (preceding[preceding.length - 1] ?? firstRead.line)
        : null,
    });
    if (keepers.length >= 8) break;
  }

  if (keepers.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    flags: keepers,
    escapedFlags: escaped.slice(0, 8),
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
