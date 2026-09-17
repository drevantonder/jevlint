import { parseSync, Visitor } from "oxc-parser";
import type { Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  calleeRootName,
  moduleImports,
  resolveModule,
} from "./repository.js";
import { isTestFilePath, parseTestFunction } from "./test-scope.js";

export type FixtureBlockEvidence = {
  filePath: string;
  kind: "beforeEach" | "beforeAll" | "factory";
  name: string | null;
  fields: string[];
  fingerprint: string;
};

export type DuplicatedFixtureDriftEvidence = {
  function: {
    title: string | null;
    filePath: string;
    source: string;
    moduleSource: string;
  };
  ownBlock: FixtureBlockEvidence;
  copies: FixtureBlockEvidence[];
  divergence: { field: string; presentIn: string[]; missingIn: string[] }[];
  sharedFactoryExists: boolean;
};

function normalizeBlock(source: string): string {
  return source
    .replaceAll(/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|`([^`\\]|\\.)*`/g, "•")
    .replaceAll(/\b\d[\d_]*(?:\.\d+)?\b/g, "•")
    .replaceAll(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function fingerprintFor(block: string): string {
  return normalizeBlock(block).slice(0, 400);
}

function blockFields(program: Program, start: number, end: number, source: string): string[] {
  const fields = new Set<string>();
  new Visitor({
    Property(node) {
      if (node.start < start || node.end > end) return;
      if (node.computed) return;
      const key = node.key;
      if (key.type === "Identifier") fields.add(key.name);
      else if (key.type === "Literal") {
        const inner = quotedInner(source.slice(key.start, key.end));
        if (inner !== null) fields.add(inner);
      }
    },
    VariableDeclarator(node) {
      if (node.start < start || node.end > end) return;
      if (node.id.type === "Identifier") fields.add(node.id.name);
    },
  }).visit(program);
  void source;
  return [...fields].sort();
}

function quotedInner(raw: string): string | null {
  const quote = raw[0];
  if (quote !== "\"" && quote !== "'" && quote !== "`") return null;
  if (raw.length < 2 || raw[raw.length - 1] !== quote) return null;
  if (quote === "`" && raw.includes("${")) return null;
  return raw.slice(1, -1);
}

function collectBlocks(file: ProjectFile): FixtureBlockEvidence[] {
  const parsed = parseSync(file.filePath, file.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return [];
  const blocks: FixtureBlockEvidence[] = [];
  new Visitor({
    CallExpression(call) {
      const root = calleeRootName(call.callee);
      if (root !== "beforeEach" && root !== "beforeAll") return;
      const callback = call.arguments.find((argument) => {
        const value = argument.type === "ChainExpression" ? argument.expression : argument;
        return value.type === "ArrowFunctionExpression" || value.type === "FunctionExpression";
      });
      if (!callback || callback.type === "ChainExpression") return;
      const body = file.source.slice(callback.start, callback.end);
      blocks.push({
        filePath: file.filePath,
        kind: root === "beforeAll" ? "beforeAll" : "beforeEach",
        name: null,
        fields: blockFields(parsed.program, callback.start, callback.end, file.source),
        fingerprint: fingerprintFor(body),
      });
    },
    FunctionDeclaration(node) {
      const name = node.id?.name;
      if (!name || !/fixture|factory|create[A-Z]|make[A-Z]|build[A-Z]|setup/i.test(name)) return;
      const body = file.source.slice(node.start, node.end);
      blocks.push({
        filePath: file.filePath,
        kind: "factory",
        name,
        fields: blockFields(parsed.program, node.start, node.end, file.source),
        fingerprint: fingerprintFor(body),
      });
    },
    VariableDeclarator(node) {
      if (node.id.type !== "Identifier") return;
      if (!node.init) return;
      if (node.init.type !== "ArrowFunctionExpression" && node.init.type !== "FunctionExpression") {
        return;
      }
      const name = node.id.name;
      if (!/fixture|factory|create[A-Z]|make[A-Z]|build[A-Z]|setup/i.test(name)) return;
      const body = file.source.slice(node.init.start, node.init.end);
      blocks.push({
        filePath: file.filePath,
        kind: "factory",
        name,
        fields: blockFields(parsed.program, node.init.start, node.init.end, file.source),
        fingerprint: fingerprintFor(body),
      });
    },
  }).visit(parsed.program);
  return blocks;
}

function fingerprintsMatch(left: string, right: string): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftTokens = new Set(left.split(" "));
  const rightTokens = new Set(right.split(" "));
  let shared = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) shared += 1;
  const smaller = Math.min(leftTokens.size, rightTokens.size);
  return smaller > 5 && shared / smaller > 0.6;
}

export function buildDuplicatedFixtureDriftEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DuplicatedFixtureDriftEvidence | undefined {
  const scope = parseTestFunction(candidate, projectFiles);
  if (!scope) return undefined;
  const { owner, program, fn } = scope;

  const ownBody = owner.source.slice(fn.start, fn.end);
  const ownFingerprint = fingerprintFor(ownBody);
  const ownIsSetup = /beforeEach|beforeAll/.test(
    owner.source.slice(Math.max(0, fn.start - 60), fn.start),
  );
  const ownName = fn.type === "FunctionDeclaration" ? fn.id?.name ?? null : null;
  const ownIsFactory = ownName !== null && /fixture|factory|create[A-Z]|make[A-Z]|build[A-Z]|setup/i.test(ownName);
  if (!ownIsSetup && !ownIsFactory) return undefined;

  const ownBlock: FixtureBlockEvidence = {
    filePath: owner.filePath,
    kind: ownIsSetup ? "beforeEach" : "factory",
    name: ownName,
    fields: blockFields(program, fn.start, fn.end, owner.source),
    fingerprint: ownFingerprint,
  };

  const copies: FixtureBlockEvidence[] = [];
  for (const file of projectFiles) {
    if (!isTestFilePath(file.filePath)) continue;
    for (const block of collectBlocks(file)) {
      if (block.filePath === owner.filePath && block.fingerprint === ownFingerprint) continue;
      if (fingerprintsMatch(ownFingerprint, block.fingerprint)) copies.push(block);
    }
  }
  const otherFileCopies = copies.filter((copy) => copy.filePath !== owner.filePath);
  if (otherFileCopies.length === 0) return undefined;

  const all = [ownBlock, ...otherFileCopies];
  const fieldPresence = new Map<string, string[]>();
  for (const block of all) {
    for (const field of block.fields) {
      const present = fieldPresence.get(field) ?? [];
      present.push(block.filePath);
      fieldPresence.set(field, present);
    }
  }
  const divergence = [...fieldPresence.entries()]
    .filter(([, presentIn]) => presentIn.length < all.length)
    .map(([field, presentIn]) => ({
      field,
      presentIn,
      missingIn: all.map((block) => block.filePath).filter((path) => !presentIn.includes(path)),
    }))
    .slice(0, 10);

  const imports = moduleImports(program);
  const sharedFactoryExists = projectFiles.some((file) => {
    if (isTestFilePath(file.filePath)) return false;
    if (!/fixture|factory/i.test(file.filePath)) return false;
    return imports.some((entry) => {
      if (!entry.source.startsWith(".")) return false;
      return resolveModule(owner.filePath, entry.source, projectFiles)?.filePath === file.filePath;
    });
  });

  return {
    function: {
      title: scope.title,
      filePath: candidate.filePath,
      source: candidate.source,
      moduleSource: owner.source.slice(0, 16_000),
    },
    ownBlock,
    copies: otherFileCopies.slice(0, 8),
    divergence,
    sharedFactoryExists,
  };
}
