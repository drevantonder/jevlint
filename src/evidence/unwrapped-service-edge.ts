import type { Candidate, ProjectFile, SourceFile } from "../types.js";
import {
  buildModuleEvidence,
  isTestFile,
  parseProgram,
} from "./module.js";
import type { ModuleEvidence } from "./module.js";
import { findModuleImporters, moduleImports, resolveModule } from "./repository.js";

export type UnwrappedServiceEdgeEvidence = {
  module: ModuleEvidence;
  hosts: {
    host: string;
    sample: string;
  }[];
  wrappers: {
    path: string;
    importerCount: number;
  }[];
  usesWrapper: boolean;
  callMarkers: {
    outboundCall: boolean;
    reliabilityMarkers: string[];
  };
};

const URL_PATTERN = /https?:\/\/([A-Za-z0-9.-]+(?::\d+)?)(?:[\w\-._~:/?#[\]@!$&'()*+,;=%]*)?/g;
const OUTBOUND_CALL_PATTERN =
  /(fetch\s*\(|axios|XMLHttpRequest|WebSocket|EventSource|createConnection|net\.connect|\.get\s*\(|\.post\s*\(|\.request\s*\()/;
const RELIABILITY_PATTERN = /\b(retry|timeout|signal|AbortController|trace|span|otel|metric|log)\b/gi;
const WRAPPER_BASENAME_PATTERN = /(client|http|api|transport|fetch|request)/i;

const HTTPISH_ROOTS = new Set([
  "axios",
  "node-fetch",
  "undici",
  "got",
  "superagent",
  "ky",
  "ofetch",
  "wretch",
  "redaxios",
  "bent",
  "needle",
  "urllib",
  "cross-fetch",
  "isomorphic-fetch",
  "whatwg-fetch",
  "make-fetch-happen",
  "follow-redirects",
  "https-proxy-agent",
  "node:http",
  "node:https",
]);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function hostsInText(text: string): Map<string, string> {
  const hosts = new Map<string, string>();
  for (const match of text.matchAll(URL_PATTERN)) {
    const host = (match[1] ?? "").toLowerCase();
    if (!host || hosts.has(host)) continue;
    hosts.set(host, match[0].slice(0, 120));
  }
  return hosts;
}

function isLocalHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host.endsWith(".test")) return true;
  if (host === "example.com" || host === "example.org" || host === "example.net") return true;
  return false;
}

function addedTextOf(source: string, changedLines: { start: number; end: number }[]): string {
  const lines = source.split("\n");
  const parts: string[] = [];
  for (const range of changedLines) {
    for (let line = range.start; line <= range.end; line += 1) {
      const text = lines[line - 1];
      if (text !== undefined) parts.push(text);
    }
  }
  return parts.join("\n");
}

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/") && !specifier.startsWith("#")
    && !specifier.startsWith("node:");
}

function wrapperPaths(projectFiles: ProjectFile[], candidatePath: string): { path: string; importerCount: number }[] {
  const wrappers: { path: string; importerCount: number }[] = [];
  for (const file of projectFiles) {
    if (file.filePath === candidatePath) continue;
    if (isTestFile(file.filePath, projectFiles)) continue;
    const program = parseProgram(file.filePath, file.source);
    if (!program) continue;
    const bare = moduleImports(program)
      .map((item) => item.source)
      .filter(isBareSpecifier);
    if (bare.length === 0) continue;
    const httpish = bare.some((specifier) => HTTPISH_ROOTS.has(specifier.split("/")[0] ?? ""));
    const named = WRAPPER_BASENAME_PATTERN.test(file.filePath.split("/").pop() ?? "");
    if (!httpish && !named) continue;
    const importerCount = findModuleImporters(file.filePath, projectFiles).length;
    if (importerCount >= 2) wrappers.push({ path: file.filePath, importerCount });
  }
  wrappers.sort((left, right) =>
    right.importerCount - left.importerCount || left.path.localeCompare(right.path)
  );
  return wrappers.slice(0, 6);
}

export function buildUnwrappedServiceEdgeEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
  changes: SourceFile[] = [],
): UnwrappedServiceEdgeEvidence | undefined {
  if (candidate.kind !== "module") return undefined;
  const module = buildModuleEvidence(candidate.filePath, changes, projectFiles);
  if (!module) return undefined;

  const change = changes.find((item) => item.filePath === candidate.filePath);
  if (!change) return undefined;
  const added = addedTextOf(change.source, change.changedLines);
  if (added.trim() === "") return undefined;

  const addedHosts = hostsInText(added);
  if (addedHosts.size === 0) return undefined;
  const oldHosts = hostsInText(change.oldSource ?? "");
  const inventory = new Map<string, string>();
  for (const file of projectFiles) {
    if (file.filePath === candidate.filePath) continue;
    for (const [host, sample] of hostsInText(file.source)) {
      if (!inventory.has(host)) inventory.set(host, sample);
    }
  }

  const novel: { host: string; sample: string }[] = [];
  for (const [host, sample] of addedHosts) {
    if (isLocalHost(host)) continue;
    if (oldHosts.has(host)) continue;
    if (inventory.has(host)) continue;
    novel.push({ host, sample });
  }
  if (novel.length === 0) return undefined;

  const outboundCall = OUTBOUND_CALL_PATTERN.test(added);
  if (!outboundCall) return undefined;

  const reliabilityMarkers = [...new Set(
    [...added.matchAll(RELIABILITY_PATTERN)].map((match) => (match[1] ?? "").toLowerCase()),
  )].sort();

  const wrappers = wrapperPaths(projectFiles, candidate.filePath);
  const wrapperSet = new Set(wrappers.map((wrapper) => wrapper.path));
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  let usesWrapper = false;
  if (owner) {
    const program = parseProgram(owner.filePath, owner.source);
    if (program) {
      for (const imported of moduleImports(program)) {
        const resolved = resolveModule(owner.filePath, imported.source, projectFiles);
        if (resolved && wrapperSet.has(resolved.filePath)) {
          usesWrapper = true;
          break;
        }
      }
    }
  }

  novel.sort((left, right) => left.host.localeCompare(right.host));
  return {
    module,
    hosts: novel,
    wrappers,
    usesWrapper,
    callMarkers: { outboundCall, reliabilityMarkers },
  };
}
