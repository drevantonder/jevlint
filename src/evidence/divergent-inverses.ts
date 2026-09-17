import { parseSync, Visitor } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  functionName,
  isFunctionExported,
} from "./repository.js";

export type InverseSideSets = {
  fieldsRead: string[];
  keysWritten: string[];
  variants: string[];
};

export type DivergentInversesEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  inverse: {
    name: string;
    source: string;
  };
  forward: InverseSideSets;
  backward: InverseSideSets;
  writerOnly: string[];
  readerOnly: string[];
  symmetricDifference: number;
};

const DOCUMENTED_LOSSY = /lossy|cache hint|recomputed on read|intentional|best.?effort|approximat/i;

const GLOBAL_OBJECTS = new Set(["JSON", "Object", "Array", "String", "Number", "Math", "console"]);

const INVERSE_WORDS: Array<[string, string[]]> = [
  ["encode", ["decode"]],
  ["decode", ["encode"]],
  ["serialize", ["deserialize", "parse"]],
  ["deserialize", ["serialize"]],
  ["stringify", ["parse"]],
  ["parse", ["stringify", "serialize"]],
  ["pack", ["unpack"]],
  ["unpack", ["pack"]],
  ["marshal", ["unmarshal"]],
  ["unmarshal", ["marshal"]],
  ["dump", ["load"]],
  ["load", ["dump"]],
];

function inverseNames(name: string): string[] {
  const lower = name.toLowerCase();
  const results: string[] = [];
  for (const [word, inverses] of INVERSE_WORDS) {
    if (lower.includes(word)) {
      for (const inverse of inverses) {
        results.push(name.replace(new RegExp(word, "i"), inverse));
      }
    }
  }
  const toMatch = /^to([A-Z_].*)$/.exec(name);
  if (toMatch) results.push(`from${toMatch[1]}`);
  const fromMatch = /^from([A-Z_].*)$/.exec(name);
  if (fromMatch) results.push(`to${fromMatch[1]}`);
  return [...new Set(results)].filter((candidate) => candidate !== name);
}

function unquote(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' || first === "'" || first === "`") && first === last) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function collectSets(source: string, start: number, end: number): InverseSideSets {
  const body = `function __side() ${source.slice(start, end).startsWith("{") ? source.slice(start, end) : `{ ${source.slice(start, end)} }`}`;
  const parsed = parseSync("side.ts", body, { range: true });
  const fieldsRead = new Set<string>();
  const keysWritten = new Set<string>();
  const variants = new Set<string>();
  if (parsed.errors.some((error) => error.severity === "Error")) {
    return { fieldsRead: [], keysWritten: [], variants: [] };
  }
  new Visitor({
    MemberExpression(node) {
      if (node.object.type === "Identifier" && GLOBAL_OBJECTS.has(node.object.name)) return;
      if (node.property.type === "Identifier") fieldsRead.add(node.property.name);
      if (node.property.type === "Literal") {
        fieldsRead.add(unquote(body.slice(node.property.start, node.property.end)));
      }
    },
    Property(node) {
      if (node.key.type === "Identifier") keysWritten.add(node.key.name);
      if (node.key.type === "Literal") {
        keysWritten.add(unquote(body.slice(node.key.start, node.key.end)));
      }
    },
    SwitchCase(node) {
      if (node.test?.type === "Literal") {
        const text = body.slice(node.test.start, node.test.end);
        if (text.startsWith('"') || text.startsWith("'")) {
          variants.add(unquote(text));
        }
      }
    },
  }).visit(parsed.program);
  return {
    fieldsRead: [...fieldsRead].sort(),
    keysWritten: [...keysWritten].sort(),
    variants: [...variants].sort(),
  };
}

function coverageOf(sets: InverseSideSets): Set<string> {
  return new Set([...sets.fieldsRead, ...sets.keysWritten, ...sets.variants]);
}

export function buildDivergentInversesEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DivergentInversesEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn || !fn.body) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const names = inverseNames(name);
  if (names.length === 0) return undefined;

  let inverseNode: { start: number; end: number } | undefined;
  let inverseName: string | undefined;
  new Visitor({
    FunctionDeclaration(node) {
      if (inverseNode || !node.id) return;
      if (names.includes(node.id.name)) {
        inverseNode = { start: node.start, end: node.end };
        inverseName = node.id.name;
      }
    },
    VariableDeclarator(node) {
      if (inverseNode || node.id.type !== "Identifier") return;
      if (
        names.includes(node.id.name)
        && node.init
        && (node.init.type === "ArrowFunctionExpression" || node.init.type === "FunctionExpression")
      ) {
        inverseNode = { start: node.init.start, end: node.init.end };
        inverseName = node.id.name;
      }
    },
  }).visit(parsed.program);
  if (!inverseNode || !inverseName) return undefined;

  const leading = owner.source.slice(Math.max(0, candidate.start - 600), candidate.start);
  const trailing = owner.source.slice(candidate.end, candidate.end + 600);
  if (DOCUMENTED_LOSSY.test(`${leading}\n${trailing}`)) return undefined;

  const forward = collectSets(owner.source, candidate.start, candidate.end);
  const backward = collectSets(owner.source, inverseNode.start, inverseNode.end);
  if (coverageOf(forward).size === 0 || coverageOf(backward).size === 0) return undefined;

  const emitted = new Set(forward.keysWritten);
  const consumed = new Set(backward.fieldsRead);
  const writerOnly = [
    ...[...emitted].filter((key) => !consumed.has(key)),
    ...forward.variants.filter((variant) => !backward.variants.includes(variant)),
  ].sort();
  const readerOnly = [
    ...[...consumed].filter((key) => !emitted.has(key)),
    ...backward.variants.filter((variant) => !forward.variants.includes(variant)),
  ].sort();
  const symmetricDifference = writerOnly.length + readerOnly.length;
  if (symmetricDifference === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    inverse: {
      name: inverseName,
      source: owner.source.slice(inverseNode.start, inverseNode.end),
    },
    forward,
    backward,
    writerOnly,
    readerOnly,
    symmetricDifference,
  };
}
