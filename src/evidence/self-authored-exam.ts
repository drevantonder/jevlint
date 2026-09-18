import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { calleeRootName, moduleImports, resolveModule } from "./repository.js";
import { isTestFileContent } from "./test-signals.js";

export type ExamAnchor = {
  declaration: string;
  anchorFiles: string[];
  preExisting: boolean;
};

export type SelfAuthoredPairing = {
  implFile: string;
  testFile: string;
  status: "added" | "modified";
  touchedDeclarations: string[];
  testFunctions: string[];
  anchors: ExamAnchor[];
  unanchored: string[];
};

export type SelfAuthoredExamEvidence = {
  coverage: {
    totalFiles: number;
    includedFilePaths: string[];
  };
  pairings: SelfAuthoredPairing[];
  unanchored: string[];
};

const CODE_EXTENSIONS = /\.[cm]?[jt]sx?$/;

const EXAM_EVIDENCE_PATTERN = /\bexpect\s*\(|\bassert\b|\bvi\s*\.\s*(mock|fn|spyOn)\b|\bjest\s*\.\s*(mock|fn|spyOn)\b|\bsinon\s*\.\s*(stub|spy|mock)\b/;

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineAt(starts: number[], offset: number): number {
  let line = 1;
  for (let index = 0; index < starts.length; index += 1) {
    if ((starts[index] ?? 0) <= offset) line = index + 1;
    else break;
  }
  return line;
}

function overlapsChanged(
  starts: number[],
  start: number,
  end: number,
  changedLines: SourceFile["changedLines"],
): boolean {
  const first = lineAt(starts, start);
  const last = lineAt(starts, Math.max(start, end - 1));
  return changedLines.some(({ start: from, end: to }) => from <= last && to >= first);
}

function touchedDeclarations(change: SourceFile): string[] {
  const parsed = parseCached(change.filePath, change.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return [];
  const starts = lineStarts(change.source);
  const names: string[] = [];
  for (const statement of parsed.program.body) {
    const declaration = statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration"
      ? statement.declaration
      : statement;
    if (!declaration) continue;
    const inChange = change.oldSource === null
      || overlapsChanged(starts, statement.start, statement.end, change.changedLines);
    if (!inChange) continue;
    if (
      declaration.type === "FunctionDeclaration"
      || declaration.type === "ClassDeclaration"
      || declaration.type === "TSInterfaceDeclaration"
      || declaration.type === "TSTypeAliasDeclaration"
      || declaration.type === "TSEnumDeclaration"
    ) {
      const name = declaration.id?.name;
      if (name && !names.includes(name)) names.push(name);
      continue;
    }
    if (declaration.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (item.id.type === "Identifier" && !names.includes(item.id.name)) {
          names.push(item.id.name);
        }
      }
    }
  }
  return names.slice(0, 10);
}

function runnerRoot(callee: CallExpression["callee"]): string | null {
  if (callee.type === "CallExpression") return runnerRoot(callee.callee);
  return calleeRootName(callee);
}

function changedTestFunctions(change: SourceFile): string[] {
  const parsed = parseCached(change.filePath, change.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return [];
  const starts = lineStarts(change.source);
  const names: string[] = [];
  new Visitor({
    CallExpression(call) {
      if (runnerRoot(call.callee) !== "it" && runnerRoot(call.callee) !== "test") return;
      for (const argument of call.arguments) {
        if (argument.type === "SpreadElement") continue;
        const value = argument.type === "ChainExpression" ? argument.expression : argument;
        if (
          value.type !== "ArrowFunctionExpression"
          && value.type !== "FunctionExpression"
        ) continue;
        const inChange = change.oldSource === null
          || overlapsChanged(starts, value.start, value.end, change.changedLines);
        if (!inChange) continue;
        const body = change.source.slice(value.start, value.end);
        if (!EXAM_EVIDENCE_PATTERN.test(body)) continue;
        const title = call.arguments[0];
        const label = title && title.type !== "SpreadElement" && title.type === "Literal"
          ? change.source.slice(title.start, title.end).slice(0, 80)
          : `line ${lineAt(starts, value.start)}`;
        if (!names.includes(label)) names.push(label);
      }
    },
  }).visit(parsed.program);
  return names.slice(0, 10);
}

function testFileTargetsImpl(testChange: SourceFile, implPath: string, projectFiles: ProjectFile[]): boolean {
  const parsed = parseCached(testChange.filePath, testChange.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return false;
  return moduleImports(parsed.program).some((entry) => {
    if (!entry.source.startsWith(".")) return false;
    return resolveModule(testChange.filePath, entry.source, projectFiles)?.filePath === implPath;
  });
}

function anchorFilesFor(
  declaration: string,
  implPath: string,
  testPaths: Set<string>,
  projectFiles: ProjectFile[],
): string[] {
  const pattern = new RegExp(`\\b${declaration.replace(/\$/g, "\\$")}\\b`);
  const anchors: string[] = [];
  for (const file of projectFiles) {
    if (file.filePath === implPath || testPaths.has(file.filePath)) continue;
    if (pattern.test(file.source)) anchors.push(file.filePath);
    if (anchors.length >= 8) break;
  }
  return anchors;
}

export function buildSelfAuthoredExamEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): SelfAuthoredExamEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  if (changes.length === 0) return undefined;

  const changedPaths = new Set(changes.map(({ filePath }) => filePath));
  const testChanges = changes.filter((change) =>
    isTestFileContent(change.filePath, change.source) && CODE_EXTENSIONS.test(change.filePath)
  );
  const implChanges = changes.filter((change) =>
    !isTestFileContent(change.filePath, change.source) && CODE_EXTENSIONS.test(change.filePath)
  );
  if (testChanges.length === 0 || implChanges.length === 0) return undefined;

  const pairings: SelfAuthoredPairing[] = [];
  for (const testChange of testChanges) {
    const testFunctions = changedTestFunctions(testChange);
    if (testFunctions.length === 0) continue;
    for (const implChange of implChanges) {
      const touched = touchedDeclarations(implChange);
      if (touched.length === 0) continue;
      if (!testFileTargetsImpl(testChange, implChange.filePath, projectFiles)) continue;
      const testPaths = new Set([testChange.filePath]);
      const anchors: ExamAnchor[] = touched.map((declaration) => {
        const anchorsFor = anchorFilesFor(declaration, implChange.filePath, testPaths, projectFiles);
        return {
          declaration,
          anchorFiles: anchorsFor,
          preExisting: anchorsFor.some((filePath) => !changedPaths.has(filePath)),
        };
      });
      pairings.push({
        implFile: implChange.filePath,
        testFile: testChange.filePath,
        status: testChange.oldSource === null ? "added" : "modified",
        touchedDeclarations: touched,
        testFunctions,
        anchors,
        unanchored: anchors.filter((anchor) => anchor.anchorFiles.length === 0).map((anchor) => anchor.declaration),
      });
    }
  }

  if (pairings.length === 0) return undefined;

  return {
    coverage: {
      totalFiles: changes.length,
      includedFilePaths: [...new Set(pairings.flatMap((pairing) => [pairing.implFile, pairing.testFile]))],
    },
    pairings: pairings.slice(0, 8),
    unanchored: [...new Set(pairings.flatMap((pairing) => pairing.unanchored))],
  };
}
