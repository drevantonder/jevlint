import { parseSync } from "oxc-parser";
import type { Program } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import {
  findDirectFunction,
  findFunctionCallers,
  findModuleImporters,
  functionName,
  isFunctionExported,
  moduleImports,
} from "./repository.js";
import type { FunctionCaller, ModuleImporter } from "./repository.js";

const MAX_EXPOSED_TYPES = 6;
const MAX_CALLERS = 8;

const STANDARD_TYPE_PATTERN =
  /^(string|number|boolean|bigint|symbol|undefined|null|void|never|any|unknown|object|Date|Error|RegExp|Promise|Array|ReadonlyArray|Record|Partial|Required|Readonly|Pick|Omit|Exclude|Extract|Map|Set|WeakMap|WeakSet|Uint8Array|ArrayBuffer|Iterable|Iterator|Generator|Function|JSON|Response|Request|Headers|URL|URLSearchParams)$/;
const INFRA_PATH_PATTERN =
  /(^|\/)(db|database|persistence|repo|repository|repositories|store|storage|orm|prisma|drizzle|mongoose|sequelize|typeorm|redis|kafka|queue|transport|http|grpc|graphql|client|driver|sdk|express|fastify|hono|nestjs|s3|dynamo|mongo|postgres|pg|mysql|sqlite)(s)?(\/|$|-|\.)/i;

export type ExposedTypeOrigin = "builtin" | "local-alias" | "project-module" | "external-package";

export type ExposedSignatureType = {
  name: string;
  position: "parameter" | "return";
  origin: ExposedTypeOrigin;
  importedFrom: string | null;
  targetLooksInfrastructural: boolean;
};

export type ImplementationTypeInSignatureEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  exposedTypes: ExposedSignatureType[];
  domainAlternativeNearby: string[];
  callers: FunctionCaller[];
  moduleImporters: ModuleImporter[];
};

function localTypeNames(program: Program): Set<string> {
  const names = new Set<string>();
  for (const statement of program.body) {
    const declaration = statement.type === "ExportNamedDeclaration"
      ? statement.declaration
      : statement;
    if (
      declaration?.type === "TSInterfaceDeclaration"
      || declaration?.type === "TSTypeAliasDeclaration"
    ) names.add(declaration.id.name);
  }
  return names;
}

function annotationIdentifiers(annotation: string): string[] {
  const found: string[] = [];
  const pattern = /\b([A-Z][A-Za-z0-9_$]*)\b/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(annotation)) !== null) {
    const name = match[1];
    if (name && !found.includes(name)) found.push(name);
  }
  return found;
}

function returnAnnotationText(source: string, paramsEnd: number, bodyStart: number): string {
  const between = source.slice(paramsEnd, bodyStart);
  const match = /\)\s*:\s*(.+?)\s*(?:=>)?$/.exec(between.trim());
  return match?.[1]?.trim() ?? "";
}

export function buildImplementationTypeInSignatureEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): ImplementationTypeInSignatureEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;
  if (!isFunctionExported(parsed.program, fn, name)) return undefined;

  const locals = localTypeNames(parsed.program);
  const imports = moduleImports(parsed.program);
  const exposed: ExposedSignatureType[] = [];
  const seen = new Set<string>();

  const classify = (typeName: string, position: "parameter" | "return"): void => {
    const key = `${position}:${typeName}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (STANDARD_TYPE_PATTERN.test(typeName)) return;
    if (locals.has(typeName)) {
      exposed.push({
        name: typeName,
        position,
        origin: "local-alias",
        importedFrom: null,
        targetLooksInfrastructural: false,
      });
      return;
    }
    const imported = imports.find(({ local }) => local === typeName);
    if (!imported) return;
    const external = !imported.source.startsWith(".");
    exposed.push({
      name: typeName,
      position,
      origin: external ? "external-package" : "project-module",
      importedFrom: imported.source,
      targetLooksInfrastructural: external || INFRA_PATH_PATTERN.test(imported.source),
    });
  };

  for (const parameter of fn.params) {
    const text = owner.source.slice(parameter.start, parameter.end);
    const annotation = text.match(/:\s*(.+?)\s*(=\s*.+)?$/)?.[1] ?? "";
    for (const typeName of annotationIdentifiers(annotation)) classify(typeName, "parameter");
  }
  const paramsEnd = fn.params.length > 0 ? fn.params[fn.params.length - 1]?.end : undefined;
  const bodyStart = fn.body?.start;
  if (paramsEnd !== undefined && bodyStart !== undefined) {
    const annotation = returnAnnotationText(owner.source, paramsEnd, bodyStart);
    for (const typeName of annotationIdentifiers(annotation)) classify(typeName, "return");
  }

  // Untyped or locally-shaped signatures bind callers to nothing
  // outside the module; there is no exposure to judge.
  const external = exposed.filter(({ origin }) =>
    origin === "external-package" || origin === "project-module"
  );
  if (external.length === 0) return undefined;

  return {
    function: {
      name,
      exported: true,
      filePath: candidate.filePath,
      source: candidate.source,
    },
    exposedTypes: [...exposed].slice(0, MAX_EXPOSED_TYPES),
    domainAlternativeNearby: [...locals],
    callers: findFunctionCallers(candidate.filePath, name, projectFiles).slice(0, MAX_CALLERS),
    moduleImporters: findModuleImporters(candidate.filePath, projectFiles),
  };
}
