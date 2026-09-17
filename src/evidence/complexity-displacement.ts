import { parseSync } from "oxc-parser";
import type { Node } from "oxc-parser";
import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import { findFunctionCallersWithCoverage } from "./repository.js";
import type { FunctionCaller } from "./repository.js";

const MAX_INCLUDED_FILES = 8;
const MAX_LISTED_OMITTED_FILES = 24;
const MAX_DECLARATIONS_PER_SNAPSHOT = 6;
const MAX_SOURCE_CHARS_PER_SNAPSHOT = 1_100;
const MAX_SOURCE_CHARS_PER_DECLARATION = 300;
const MAX_CALLER_CHANGES = 10;
const MAX_CALLERS_PER_STATE = 2;
const MAX_CALL_CHARS = 240;
const MAX_ARGUMENTS = 4;
const MAX_ARGUMENT_CHARS = 100;

type ParsedDeclaration = {
  kind: string;
  name: string;
  start: number;
  end: number;
};

type DeclarationEvidence = {
  kind: string;
  name: string;
  changed: boolean;
  sourceIncluded: boolean;
  sourceTruncated: boolean;
};

type SnapshotCoverage = {
  totalChars: number;
  includedChars: number;
  omittedChars: number;
  totalDeclarations: number;
  includedDeclarations: number;
  omittedDeclarations: number;
  truncatedDeclarations: number;
};

type ChangedFileEvidence = {
  filePath: string;
  status: "added" | "modified";
  selection: "anchor" | "structural-change";
  before: string | null;
  after: string;
  beforeDeclarations: DeclarationEvidence[];
  afterDeclarations: DeclarationEvidence[];
  coverage: {
    before: SnapshotCoverage | null;
    after: SnapshotCoverage;
  };
};

type BoundedCaller = {
  filePath: string;
  line: number;
  call: string;
  arguments: string[];
  coverage: {
    callChars: number;
    includedCallChars: number;
    omittedCallChars: number;
    totalArguments: number;
    includedArguments: number;
    omittedArguments: number;
    truncatedArguments: number;
  };
};

type CallerSetEvidence = {
  total: number;
  included: number;
  omitted: number;
  callers: BoundedCaller[];
};

type CallerChangeEvidence = {
  filePath: string;
  functionName: string;
  before: CallerSetEvidence;
  after: CallerSetEvidence;
};

type CallerChangesEvidence = {
  total: number;
  included: CallerChangeEvidence[];
};

export type ComplexityDisplacementEvidence = {
  anchorFile: string;
  coverage: {
    totalFiles: number;
    includedFiles: number;
    omittedFiles: number;
    includedFilePaths: string[];
    omittedFilePaths: string[];
    unlistedOmittedFiles: number;
    truncatedFiles: string[];
    totalCallerChanges: number;
    includedCallerChanges: number;
    omittedCallerChanges: number;
  };
  files: ChangedFileEvidence[];
  callerChanges: CallerChangeEvidence[];
};

type Snapshot = {
  source: string;
  declarations: DeclarationEvidence[];
  coverage: SnapshotCoverage;
};

function declarationStatement(statement: Node): Node | null {
  if (statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration") {
    return statement.declaration;
  }
  return statement;
}

function parsedDeclarations(filePath: string, source: string): ParsedDeclaration[] {
  const parsed = parseSync(filePath, source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return [];
  const result: ParsedDeclaration[] = [];
  for (const statement of parsed.program.body) {
    const declaration = declarationStatement(statement);
    if (!declaration) continue;
    if (
      declaration.type === "FunctionDeclaration"
      || declaration.type === "ClassDeclaration"
      || declaration.type === "TSInterfaceDeclaration"
      || declaration.type === "TSTypeAliasDeclaration"
      || declaration.type === "TSEnumDeclaration"
    ) {
      const name = declaration.id?.name;
      if (name) result.push({
        kind: declaration.type,
        name,
        start: statement.start,
        end: statement.end,
      });
      continue;
    }
    if (declaration.type === "VariableDeclaration") {
      for (const item of declaration.declarations) {
        if (item.id.type !== "Identifier") continue;
        result.push({
          kind: declaration.type,
          name: item.id.name,
          start: statement.start,
          end: statement.end,
        });
      }
    }
  }
  return result;
}

function declarationKey(declaration: ParsedDeclaration): string {
  return `${declaration.kind}:${declaration.name}`;
}

function changedDeclaration(
  declaration: ParsedDeclaration,
  source: string,
  counterparts: Map<string, { declaration: ParsedDeclaration; source: string }>,
): boolean {
  const counterpart = counterparts.get(declarationKey(declaration));
  return counterpart === undefined
    || source.slice(declaration.start, declaration.end)
      !== counterpart.source.slice(counterpart.declaration.start, counterpart.declaration.end);
}

function snapshot(
  filePath: string,
  source: string,
  counterpartSource: string | null,
): Snapshot {
  const all = parsedDeclarations(filePath, source);
  const counterparts = new Map<string, { declaration: ParsedDeclaration; source: string }>();
  if (counterpartSource !== null) {
    for (const declaration of parsedDeclarations(filePath, counterpartSource)) {
      counterparts.set(declarationKey(declaration), { declaration, source: counterpartSource });
    }
  }
  const ranked = all.map((declaration) => ({
    declaration,
    changed: changedDeclaration(declaration, source, counterparts),
  })).sort((left, right) =>
    Number(right.changed) - Number(left.changed)
    || left.declaration.start - right.declaration.start
    || left.declaration.name.localeCompare(right.declaration.name)
  );
  const selected = ranked.slice(0, MAX_DECLARATIONS_PER_SNAPSHOT);
  const chunks: string[] = [];
  const usedRanges = new Set<string>();
  let includedChars = 0;
  let truncatedDeclarations = 0;
  const declarations = selected.map(({ declaration, changed }): DeclarationEvidence => {
    const rangeKey = `${declaration.start}:${declaration.end}`;
    const remaining = MAX_SOURCE_CHARS_PER_SNAPSHOT - includedChars;
    const available = Math.min(
      declaration.end - declaration.start,
      MAX_SOURCE_CHARS_PER_DECLARATION,
      Math.max(0, remaining),
    );
    const sourceIncluded = available > 0 && !usedRanges.has(rangeKey);
    const sourceTruncated = sourceIncluded && available < declaration.end - declaration.start;
    if (sourceIncluded) {
      chunks.push(source.slice(declaration.start, declaration.start + available));
      includedChars += available;
      usedRanges.add(rangeKey);
      if (sourceTruncated) truncatedDeclarations += 1;
    }
    return {
      kind: declaration.kind,
      name: declaration.name,
      changed,
      sourceIncluded,
      sourceTruncated,
    };
  });

  if (chunks.length === 0 && source.length > 0) {
    const included = Math.min(source.length, MAX_SOURCE_CHARS_PER_SNAPSHOT);
    chunks.push(source.slice(0, included));
    includedChars = included;
  }
  return {
    source: chunks.join("\n\n"),
    declarations,
    coverage: {
      totalChars: source.length,
      includedChars,
      omittedChars: source.length - includedChars,
      totalDeclarations: all.length,
      includedDeclarations: selected.length,
      omittedDeclarations: all.length - selected.length,
      truncatedDeclarations,
    },
  };
}

function structuralChangeScore(change: SourceFile): number {
  if (change.oldSource === null) return parsedDeclarations(change.filePath, change.source).length + 1;
  const before = parsedDeclarations(change.filePath, change.oldSource);
  const after = parsedDeclarations(change.filePath, change.source);
  const beforeByKey = new Map(before.map((declaration) => [declarationKey(declaration), declaration]));
  const afterByKey = new Map(after.map((declaration) => [declarationKey(declaration), declaration]));
  let score = 0;
  for (const declaration of before) {
    const next = afterByKey.get(declarationKey(declaration));
    if (!next || change.oldSource.slice(declaration.start, declaration.end)
      !== change.source.slice(next.start, next.end)) score += 1;
  }
  for (const declaration of after) {
    if (!beforeByKey.has(declarationKey(declaration))) score += 1;
  }
  return score;
}

function prioritizedChanges(candidate: Candidate, changes: SourceFile[]): SourceFile[] {
  return changes.map((change) => ({ change, score: structuralChangeScore(change) }))
    .sort((left, right) => {
      if (left.change.filePath === candidate.filePath) return -1;
      if (right.change.filePath === candidate.filePath) return 1;
      return right.score - left.score
        || left.change.filePath.localeCompare(right.change.filePath);
    })
    .map(({ change }) => change);
}

function beforeProjectFiles(
  projectFiles: ProjectFile[],
  changes: SourceFile[],
): ProjectFile[] {
  const changesByPath = new Map(changes.map((change) => [change.filePath, change]));
  return projectFiles.flatMap((file) => {
    const change = changesByPath.get(file.filePath);
    if (!change) return [file];
    return change.oldSource === null ? [] : [{ filePath: file.filePath, source: change.oldSource }];
  });
}

function boundedText(value: string, limit: number): string {
  return value.slice(0, limit);
}

function boundedCaller(caller: FunctionCaller): BoundedCaller {
  const call = boundedText(caller.call, MAX_CALL_CHARS);
  const selectedArguments = caller.arguments.slice(0, MAX_ARGUMENTS);
  const arguments_ = selectedArguments.map((argument) => boundedText(argument, MAX_ARGUMENT_CHARS));
  return {
    filePath: caller.filePath,
    line: caller.line,
    call,
    arguments: arguments_,
    coverage: {
      callChars: caller.call.length,
      includedCallChars: call.length,
      omittedCallChars: caller.call.length - call.length,
      totalArguments: caller.arguments.length,
      includedArguments: arguments_.length,
      omittedArguments: caller.arguments.length - arguments_.length,
      truncatedArguments: selectedArguments.filter((argument) => argument.length > MAX_ARGUMENT_CHARS).length,
    },
  };
}

function boundedCallers(
  ownerPath: string,
  functionName: string,
  projectFiles: ProjectFile[],
): CallerSetEvidence {
  const result = findFunctionCallersWithCoverage(ownerPath, functionName, projectFiles);
  const callers = result.callers.slice(0, MAX_CALLERS_PER_STATE).map(boundedCaller);
  return {
    total: result.total,
    included: callers.length,
    omitted: result.total - callers.length,
    callers,
  };
}

function callerChanges(
  changes: SourceFile[],
  beforeFiles: ProjectFile[],
  afterFiles: ProjectFile[],
): CallerChangesEvidence {
  const namesByFile = changes.map((change) => {
    const names: string[] = [];
    const seen = new Set<string>();
    const declarations = [
      ...(change.oldSource === null ? [] : parsedDeclarations(change.filePath, change.oldSource)),
      ...parsedDeclarations(change.filePath, change.source),
    ];
    for (const declaration of declarations) {
      if (declaration.kind !== "FunctionDeclaration" || seen.has(declaration.name)) continue;
      seen.add(declaration.name);
      names.push(declaration.name);
    }
    return { filePath: change.filePath, names };
  });
  const functions: { filePath: string; functionName: string }[] = [];
  const longest = Math.max(0, ...namesByFile.map(({ names }) => names.length));
  for (let index = 0; index < longest; index += 1) {
    for (const { filePath, names } of namesByFile) {
      const functionName = names[index];
      if (functionName !== undefined) functions.push({ filePath, functionName });
    }
  }
  const selected = functions.slice(0, MAX_CALLER_CHANGES).map(({ filePath, functionName }) => ({
    filePath,
    functionName,
    before: boundedCallers(filePath, functionName, beforeFiles),
    after: boundedCallers(filePath, functionName, afterFiles),
  }));
  return { total: functions.length, included: selected };
}

export function buildComplexityDisplacementEvidence(
  candidate: Candidate,
  changes: SourceFile[],
  projectFiles: ProjectFile[] = changes.map(({ filePath, source }) => ({ filePath, source })),
): ComplexityDisplacementEvidence | undefined {
  if (candidate.kind !== "change") return undefined;
  if (!changes.some(({ oldSource }) => oldSource !== null)) return undefined;

  const prioritized = prioritizedChanges(candidate, changes);
  const includedChanges = prioritized.slice(0, MAX_INCLUDED_FILES);
  const includedPaths = new Set(includedChanges.map(({ filePath }) => filePath));
  const omittedPaths = changes
    .map(({ filePath }) => filePath)
    .filter((filePath) => !includedPaths.has(filePath))
    .sort((left, right) => left.localeCompare(right));
  const previousProjectFiles = beforeProjectFiles(projectFiles, changes);
  const callers = callerChanges(prioritized, previousProjectFiles, projectFiles);
  const files = includedChanges.map((change): ChangedFileEvidence => {
    const before = change.oldSource === null
      ? null
      : snapshot(change.filePath, change.oldSource, change.source);
    const after = snapshot(change.filePath, change.source, change.oldSource);
    return {
      filePath: change.filePath,
      status: change.oldSource === null ? "added" : "modified",
      selection: change.filePath === candidate.filePath ? "anchor" : "structural-change",
      before: before?.source ?? null,
      after: after.source,
      beforeDeclarations: before?.declarations ?? [],
      afterDeclarations: after.declarations,
      coverage: { before: before?.coverage ?? null, after: after.coverage },
    };
  });
  const truncatedFiles = files.filter(({ coverage }) =>
    (coverage.before?.omittedChars ?? 0) > 0
    || coverage.after.omittedChars > 0
    || (coverage.before?.omittedDeclarations ?? 0) > 0
    || coverage.after.omittedDeclarations > 0
  ).map(({ filePath }) => filePath);
  const listedOmittedPaths = omittedPaths.slice(0, MAX_LISTED_OMITTED_FILES);

  return {
    anchorFile: candidate.filePath,
    coverage: {
      totalFiles: changes.length,
      includedFiles: includedChanges.length,
      omittedFiles: omittedPaths.length,
      includedFilePaths: includedChanges.map(({ filePath }) => filePath),
      omittedFilePaths: listedOmittedPaths,
      unlistedOmittedFiles: omittedPaths.length - listedOmittedPaths.length,
      truncatedFiles,
      totalCallerChanges: callers.total,
      includedCallerChanges: callers.included.length,
      omittedCallerChanges: callers.total - callers.included.length,
    },
    files,
    callerChanges: callers.included,
  };
}
