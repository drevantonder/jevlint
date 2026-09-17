import { parseSync, Visitor } from "oxc-parser";
import type {
  JSXAttributeItem,
  JSXChild,
  JSXElementName,
} from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
  nestedFunctionRanges,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type UnlabeledElement = {
  tag: string;
  line: number;
  expression: string;
  dynamicChildren: boolean;
  titled: boolean;
  trigger: "button" | "input" | "select" | "textarea" | "link-click" | "role-button";
};

export type UnlabeledInteractiveElementEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  elements: UnlabeledElement[];
  associatedLabels: string[];
  componentTags: string[];
  callers: FunctionCaller[];
};

const LABELED_INPUT_TYPES = new Set(["hidden"]);

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

function tagNameOf(name: JSXElementName): string | undefined {
  if (name.type === "JSXIdentifier") return name.name;
  return undefined;
}

function attributeMap(attributes: JSXAttributeItem[], source: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const attribute of attributes) {
    if (attribute.type !== "JSXAttribute") continue;
    if (attribute.name.type !== "JSXIdentifier") continue;
    const key = attribute.name.name;
    const value = attribute.value;
    if (!value) {
      result.set(key, "");
      continue;
    }
    if (value.type === "Literal" && value.raw !== null) {
      const raw = value.raw;
      const quoted = (raw.startsWith("\"") || raw.startsWith("'")) && raw.length >= 2;
      result.set(key, quoted ? raw.slice(1, -1) : raw);
      continue;
    }
    if (value.type === "JSXExpressionContainer") {
      result.set(key, source.slice(value.start, value.end));
      continue;
    }
    result.set(key, "");
  }
  return result;
}

function hasVisibleText(children: JSXChild[]): boolean {
  return children.some((child) => {
    if (child.type !== "JSXText") return false;
    return /[A-Za-z0-9À-ÿĀ-žЀ-џ一-鿿가-힯]/.test(child.value);
  });
}

function hasDynamicChildren(children: JSXChild[]): boolean {
  return children.some((child) => child.type === "JSXExpressionContainer");
}

export function buildUnlabeledInteractiveElementEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): UnlabeledInteractiveElementEvidence | undefined {
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
  const inScope = (start: number, end: number): boolean =>
    start >= candidate.start && end <= candidate.end
    && !nested.some((range) => range.start <= start && range.end >= end);

  const associatedLabels = new Set<string>();
  new Visitor({
    JSXElement(node) {
      const tag = tagNameOf(node.openingElement.name);
      if (tag !== "label") return;
      const attributes = attributeMap(node.openingElement.attributes, owner.source);
      const target = attributes.get("htmlFor") ?? attributes.get("for");
      if (target !== undefined && target.length > 0) associatedLabels.add(target);
    },
  }).visit(parsed.program);

  const elements: UnlabeledElement[] = [];
  const componentTags = new Set<string>();

  new Visitor({
    JSXElement(node) {
      if (!inScope(node.start, node.end)) return;
      const tag = tagNameOf(node.openingElement.name);
      if (!tag) {
        componentTags.add(owner.source.slice(node.openingElement.name.start, node.openingElement.name.end));
        return;
      }
      if (/^[A-Z]/.test(tag)) {
        componentTags.add(tag);
        return;
      }
      const attributes = attributeMap(node.openingElement.attributes, owner.source);
      if (attributes.get("aria-hidden") === "true") return;

      let trigger: UnlabeledElement["trigger"] | undefined;
      if (tag === "button" || tag === "input" || tag === "select" || tag === "textarea") {
        trigger = tag;
      } else if (tag === "a" && attributes.has("onClick")) {
        trigger = "link-click";
      } else if (attributes.get("role") === "button") {
        trigger = "role-button";
      }
      if (!trigger) return;

      if (trigger === "input") {
        const inputType = attributes.get("type");
        if (inputType !== undefined && LABELED_INPUT_TYPES.has(inputType.toLowerCase())) return;
        const id = attributes.get("id");
        if (id !== undefined && associatedLabels.has(id)) return;
      }

      const ariaLabel = attributes.get("aria-label");
      if (ariaLabel !== undefined && ariaLabel.trim().length > 0) return;
      if (attributes.has("aria-labelledby")) return;
      if (trigger === "input") {
        const value = attributes.get("value");
        if (value !== undefined && value.trim().length > 0) return;
      }
      if (hasVisibleText(node.children)) return;

      elements.push({
        tag,
        line: lineAt(owner.source, node.start),
        expression: owner.source.slice(node.start, node.end).slice(0, 300),
        dynamicChildren: hasDynamicChildren(node.children),
        titled: attributes.has("title"),
        trigger,
      });
    },
  }).visit(parsed.program);

  if (elements.length === 0) return undefined;

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    elements,
    associatedLabels: [...associatedLabels],
    componentTags: [...componentTags],
    callers: findFunctionCallers(candidate.filePath, name, projectFiles),
  };
}
