import { parseSync, Visitor } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { containsNode } from "./function-scope.js";
import {
  findDirectFunction,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionNode } from "./repository.js";

export type ForwardedProp = {
  name: string;
  readElsewhere: boolean;
  forwardings: string[];
};

export type StateChannel = {
  hook: string;
  from: string;
  files: string[];
};

export type DrilledPropEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  forwardedProps: ForwardedProp[];
  forwardingDepth: number;
  stateChannels: StateChannel[];
  siblingValueReads: string[];
};

const STATE_HOOK_PATTERN = /useContext|useSession|useStore|useSelector|useTheme|useAuth|useUser|useConfig/i;

function bindingNames(fn: FunctionNode): string[] {
  const names: string[] = [];
  for (const parameter of fn.params) {
    const value = parameter.type === "TSParameterProperty" ? parameter.parameter : parameter;
    if (value.type === "Identifier") {
      if (value.name !== "props") names.push(value.name);
      continue;
    }
    if (value.type === "ObjectPattern") {
      for (const property of value.properties) {
        if (property.type === "Property" && property.value.type === "Identifier") {
          names.push(property.value.name);
        } else if (property.type === "RestElement" && property.argument.type === "Identifier") {
          names.push(property.argument.name);
        }
      }
    }
  }
  return [...new Set(names)];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type Exclusion = { start: number; end: number };

function readElsewhere(
  program: Parameters<Visitor["visit"]>[0],
  fn: FunctionNode,
  name: string,
  forwardingCount: number,
): boolean {
  const excluded: Exclusion[] = fn.params.map((parameter) => ({
    start: parameter.start,
    end: parameter.end,
  }));
  new Visitor({
    JSXAttribute(node) {
      if (!containsNode(fn, node)) return;
      if (node.name.type === "JSXIdentifier") {
        excluded.push({ start: node.name.start, end: node.name.end });
      }
    },
    MemberExpression(node) {
      if (!containsNode(fn, node)) return;
      if (!node.computed && node.property.type === "Identifier") {
        excluded.push({ start: node.property.start, end: node.property.end });
      }
    },
  }).visit(program);
  const inside = (start: number, end: number): boolean =>
    excluded.some((range) => range.start <= start && range.end >= end);

  let reads = 0;
  new Visitor({
    Identifier(node) {
      if (node.name !== name) return;
      if (!containsNode(fn, node)) return;
      if (inside(node.start, node.end)) return;
      reads += 1;
    },
  }).visit(program);
  return reads > forwardingCount;
}

function jsxForwardings(
  program: Parameters<Visitor["visit"]>[0],
  fn: FunctionNode,
  source: string,
): Map<string, string[]> {
  const forwardings = new Map<string, string[]>();
  new Visitor({
    JSXAttribute(node) {
      if (!containsNode(fn, node)) return;
      const attributeName = node.name.type === "JSXIdentifier" ? node.name.name : null;
      const value = node.value;
      if (attributeName === null || value?.type !== "JSXExpressionContainer") return;
      if (value.expression.type !== "Identifier") return;
      if (value.expression.name !== attributeName) return;
      const existing = forwardings.get(attributeName) ?? [];
      existing.push(source.slice(node.start, node.end).slice(0, 120));
      forwardings.set(attributeName, existing);
    },
  }).visit(program);
  return forwardings;
}

function stateChannels(projectFiles: ProjectFile[]): StateChannel[] {
  const channels = new Map<string, StateChannel>();
  const addChannel = (hook: string, from: string, filePath: string): void => {
    const key = `${hook} from ${from}`;
    const existing = channels.get(key);
    if (existing) {
      if (!existing.files.includes(filePath)) existing.files.push(filePath);
    } else {
      channels.set(key, { hook, from, files: [filePath] });
    }
  };
  for (const file of projectFiles) {
    const parsed = parseSync(file.filePath, file.source, { range: true });
    if (parsed.errors.some((error) => error.severity === "Error")) continue;
    for (const imported of moduleImports(parsed.program)) {
      if (!STATE_HOOK_PATTERN.test(imported.local)) continue;
      addChannel(imported.local, imported.source, file.filePath);
    }
    new Visitor({
      FunctionDeclaration(node) {
        if (node.id && STATE_HOOK_PATTERN.test(node.id.name)) {
          addChannel(node.id.name, file.filePath, file.filePath);
        }
      },
      VariableDeclarator(node) {
        if (
          node.id.type === "Identifier"
          && STATE_HOOK_PATTERN.test(node.id.name)
          && (node.init?.type === "ArrowFunctionExpression" || node.init?.type === "FunctionExpression")
        ) addChannel(node.id.name, file.filePath, file.filePath);
      },
    }).visit(parsed.program);
  }
  return [...channels.values()]
    .map((channel) => ({ ...channel, files: channel.files.slice(0, 10) }))
    .slice(0, 10);
}

export function buildDrilledPropEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): DrilledPropEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const parameters = bindingNames(fn);
  if (parameters.length === 0) return undefined;
  const forwardings = jsxForwardings(parsed.program, fn, owner.source);
  if (forwardings.size === 0) return undefined;

  const forwardedProps: ForwardedProp[] = [];
  for (const name of parameters) {
    const attributeForwardings = forwardings.get(name);
    if (!attributeForwardings) continue;
    forwardedProps.push({
      name,
      readElsewhere: readElsewhere(parsed.program, fn, name, attributeForwardings.length),
      forwardings: attributeForwardings.slice(0, 5),
    });
  }
  const unread = forwardedProps.filter((prop) => !prop.readElsewhere);
  if (unread.length === 0) return undefined;

  const channels = stateChannels(projectFiles);
  const channelFiles = new Set(channels.flatMap(({ files }) => files));
  const siblingValueReads: string[] = [];
  for (const { name: prop } of unread) {
    const pattern = new RegExp(`\\b${escapeRegExp(prop)}\\b`);
    for (const file of projectFiles) {
      if (file.filePath === candidate.filePath) continue;
      if (!channelFiles.has(file.filePath)) continue;
      if (!pattern.test(file.source)) continue;
      siblingValueReads.push(`${prop} appears in state-channel module ${file.filePath}`);
      if (siblingValueReads.length >= 10) break;
    }
  }

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    forwardedProps,
    forwardingDepth: forwardings.size,
    stateChannels: channels,
    siblingValueReads,
  };
}
