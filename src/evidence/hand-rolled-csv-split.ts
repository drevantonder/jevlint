import { parseSync } from "oxc-parser";
import type { Candidate, ProjectFile } from "../types.js";
import { manifestFacts } from "./manifest-facts.js";
import {
  findDirectFunction,
  findFunctionCallers,
  functionName,
  isFunctionExported,
} from "./repository.js";
import type { FunctionCaller } from "./repository.js";

export type CsvSplitSignal = {
  signal: string;
  excerpt: string;
};

export type HandRolledCsvSplitEvidence = {
  function: {
    name: string;
    exported: boolean;
    filePath: string;
    source: string;
  };
  ownedCsvDep: string;
  siblingImporters: string[];
  lockfilePresent: boolean;
  signals: CsvSplitSignal[];
  handlesQuotes: boolean;
  callers: FunctionCaller[];
};

const CSV_DEPS = ["csv-parse", "papaparse", "csv", "d3-dsv"];

const ROW_SPLIT_PATTERN = /\.split\s*\(\s*(?:["'`]\s*\\n\s*["'`]|["'`]\s*\\r\?\\n\s*["'`]|\/\s*\\r\?\\n\s*\/)\s*\)/;
const CELL_SPLIT_PATTERN = /\.split\s*\(\s*['"]\s*[,;|]?\s*['"]\s*\)/;
const HEADER_MAPPING_PATTERN = /\bheaders?\s*\[\s*\w+\s*\]|\bindexOf\s*\(\s*(?:header|column)/i;
const QUOTE_HANDLING_PATTERN = /\\"|\\u0022|'"'|quote/i;

export function buildHandRolledCsvSplitEvidence(
  candidate: Candidate,
  projectFiles: ProjectFile[],
): HandRolledCsvSplitEvidence | undefined {
  if (candidate.kind !== "function") return undefined;
  const owner = projectFiles.find((file) => file.filePath === candidate.filePath);
  if (!owner) return undefined;
  const parsed = parseSync(owner.filePath, owner.source, { range: true });
  if (parsed.errors.some((error) => error.severity === "Error")) return undefined;
  const fn = findDirectFunction(parsed.program, candidate);
  if (!fn) return undefined;
  const name = functionName(parsed.program, fn);
  if (!name) return undefined;

  const facts = manifestFacts(projectFiles, candidate.filePath, CSV_DEPS);
  if (!facts.matchedDep) return undefined;
  if (facts.candidateImportsDep) return undefined;

  const signals: CsvSplitSignal[] = [];
  const rowSplit = ROW_SPLIT_PATTERN.exec(candidate.source);
  if (rowSplit) signals.push({ signal: "row-split", excerpt: rowSplit[0].slice(0, 200) });
  const cellSplit = CELL_SPLIT_PATTERN.exec(candidate.source);
  if (cellSplit) signals.push({ signal: "cell-split", excerpt: cellSplit[0].slice(0, 200) });
  if (!rowSplit || !cellSplit) return undefined;

  const headerMapping = HEADER_MAPPING_PATTERN.exec(candidate.source);
  if (headerMapping) {
    signals.push({ signal: "header-index-mapping", excerpt: headerMapping[0].slice(0, 200) });
  }

  const handlesQuotes = QUOTE_HANDLING_PATTERN.test(candidate.source);
  const callers = findFunctionCallers(candidate.filePath, name, projectFiles);

  return {
    function: {
      name,
      exported: isFunctionExported(parsed.program, fn, name),
      filePath: candidate.filePath,
      source: candidate.source,
    },
    ownedCsvDep: facts.matchedDep,
    siblingImporters: facts.siblingImporters,
    lockfilePresent: facts.lockfilePresent,
    signals,
    handlesQuotes,
    callers,
  };
}
