import { builtinModules } from "node:module";
import { Visitor } from "oxc-parser";
import { parseCached } from "./parse-cache.js";
import type { CallExpression } from "oxc-parser";
import { z } from "zod";
import type { Candidate, ProjectFile } from "../types.js";
import {
  calleeRootName,
  findDirectFunction,
  functionName,
  isFunctionExported,
  manifestDependencies,
  moduleImports,
} from "./repository.js";

export type PackageImportKind = "relative" | "builtin" | "declared" | "undeclared";

export type PackageImport = {
  source: string;
  kind: PackageImportKind;
  declaredIn: string | null;
  lockfileHit: boolean;
  aliasMapped: boolean;
};

export type PhantomPackageImportEvidence = {
  function: {
    name: string | null;
    exported: boolean;
    filePath: string;
    source: string;
  };
  imports: PackageImport[];
  manifest: {
    filePath: string | null;
    dependencyNames: string[];
  };
  lockfilesChecked: string[];
  siblingBareImports: string[];
};

const BUILTINS = new Set(
  builtinModules.flatMap((name) =>
    name.startsWith("node:") ? [name, name.slice("node:".length)] : [name, `node:${name}`]
  ),
);

function nearestManifest(ownerPath: string, projectFiles: ProjectFile[]): ProjectFile | undefined {
  const manifests = projectFiles.filter((file) => /(^|\/)package\.json$/.test(file.filePath));
  const owned = manifests
    .filter((file) => {
      const dir = file.filePath.slice(0, file.filePath.length - "package.json".length);
      return ownerPath.startsWith(dir);
    })
    .sort((left, right) => right.filePath.length - left.filePath.length);
  return owned[0] ?? manifests[0];
}

function manifestLookup(ownerPath: string, projectFiles: ProjectFile[]) {
  const manifest = nearestManifest(ownerPath, projectFiles);
  const declared = manifest ? manifestDependencies(manifest.source) : [];
  return { manifest, declared };
}

const tsconfigSchema = z.object({
  compilerOptions: z.object({
    paths: z.record(z.string(), z.array(z.string())).optional(),
  }).optional(),
});

function aliasMapped(specifier: string, projectFiles: ProjectFile[]): boolean {
  for (const file of projectFiles) {
    if (!/(^|\/)tsconfig.*\.json$/.test(file.filePath)) continue;
    let json: unknown;
    try {
      json = JSON.parse(file.source);
    } catch {
      continue;
    }
    const parsed = tsconfigSchema.safeParse(json);
    if (!parsed.success) continue;
    const paths = parsed.data.compilerOptions?.paths;
    if (!paths) continue;
    for (const key of Object.keys(paths)) {
      if (key === specifier) return true;
      if (key.endsWith("/*") && specifier.startsWith(key.slice(0, -1))) return true;
    }
  }
  return false;
}

function lockfileHit(specifier: string, projectFiles: ProjectFile[]) {
  const lockfiles = projectFiles.filter((file) =>
    /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(file.filePath)
  );
  const quoted = [
    `"${specifier}"`,
    `'${specifier}'`,
    ` ${specifier}@`,
    `\n${specifier}:`,
    `/${specifier}-`,
    `/${specifier}/`,
    `node_modules/${specifier}`,
  ];
  const hit = lockfiles.some((file) => quoted.some((token) => file.source.includes(token)));
  return { hit, checked: lockfiles.map((file) => file.filePath) };
}

export function buildPhantomPackageImportEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): PhantomPackageImportEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const ownerFile = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!ownerFile) return undefined;
  const parsed = parseCached(ownerFile.filePath, ownerFile.source);
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;

  const sources = new Set(moduleImports(parsed.program).map((entry) => entry.source));
  new Visitor({
    CallExpression(call: CallExpression) {
      if (call.callee.type !== "Identifier") return;
      const root = calleeRootName(call.callee);
      if (root !== "require" && root !== "import") return;
      const first = call.arguments[0];
      if (!first || first.type === "SpreadElement" || first.type !== "Literal") return;
      const raw = ownerFile.source.slice(first.start, first.end);
      if (raw.length < 2) return;
      const quote = raw[0];
      if (quote !== "\"" && quote !== "'" && quote !== "`") return;
      if (raw[raw.length - 1] !== quote) return;
      if (quote === "`" && raw.includes("${")) return;
      sources.add(raw.slice(1, -1));
    },
  }).visit(parsed.program);

  if (sources.size === 0) return undefined;

  const { manifest, declared } = manifestLookup(candidate.filePath, projectFiles);

  const siblingBareImports = new Set<string>();
  for (const file of projectFiles) {
    if (file.filePath === candidate.filePath) continue;
    for (const match of file.source.matchAll(/(?:from\s+|require\(\s*)["']([^"']+)["']/g)) {
      const specifier = match[1];
      if (specifier && !specifier.startsWith(".") && !specifier.startsWith("/")) {
        siblingBareImports.add(specifier);
      }
    }
  }

  const imports: PackageImport[] = [];
  for (const source of sources) {
    if (source.startsWith(".") || source.startsWith("/")) {
      imports.push({ source, kind: "relative", declaredIn: null, lockfileHit: false, aliasMapped: false });
      continue;
    }
    if (BUILTINS.has(source)) {
      imports.push({ source, kind: "builtin", declaredIn: null, lockfileHit: false, aliasMapped: false });
      continue;
    }
    const declaration = declared.find((entry) => entry.name === source);
    if (declaration) {
      const { hit } = lockfileHit(source, projectFiles);
      imports.push({ source, kind: "declared", declaredIn: declaration.section, lockfileHit: hit, aliasMapped: false });
      continue;
    }
    const { hit } = lockfileHit(source, projectFiles);
    imports.push({
      source,
      kind: "undeclared",
      declaredIn: null,
      lockfileHit: hit,
      aliasMapped: aliasMapped(source, projectFiles),
    });
  }

  const name = functionName(parsed.program, fn);
  return {
    function: {
      name: name ?? null,
      exported: name ? isFunctionExported(parsed.program, fn, name) : false,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    imports,
    manifest: {
      filePath: manifest?.filePath ?? null,
      dependencyNames: declared.map((entry) => entry.name).slice(0, 60),
    },
    lockfilesChecked: lockfileHit("", projectFiles).checked,
    siblingBareImports: [...siblingBareImports].slice(0, 30),
  };
}
