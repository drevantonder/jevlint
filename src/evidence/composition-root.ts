import type { FunctionCaller } from "./repository.js";

/**
 * Composition-root detection shared by the DI rules
 * (no-construction-in-use, no-untestable-singleton-grab,
 * no-ambient-dependency-grab).
 *
 * Construction must bottom out somewhere: DI only moves the wiring decision
 * upward, and there is nothing above an entry point to receive from. An entry
 * function the runtime invokes with raw process inputs therefore abstains
 * structurally instead of being judged for building or grabbing its
 * collaborators.
 *
 * Detection is conservative and enumerates three entry signals, each
 * corroborated by seam-taking:
 *
 * 1. main()/runCli-shaped entry names,
 * 2. process.argv proximity (the module reads raw process inputs and the
 *    function touches them or receives them from its caller),
 * 3. no-caller + exported-for-runtime (a binary entry nothing in the
 *    repository calls, exported for the runtime to invoke).
 *
 * Every signal additionally requires BOTH:
 * - seam-taking params (args/cwd/stdout/stderr and kin): the function
 *   already accepts injectable seams, which corroborates that it is a
 *   wiring boundary rather than domain logic;
 * - a raw-input caller IOC: no in-repo caller at all (binary entry), or
 *   every in-repo caller passes raw process inputs (argv/env/stdin and
 *   kin). A constructed-anything-anywhere-else still fires.
 */
export type CompositionRootSignal = {
  name: string | null;
  /** Parameter names or parameter source slices; seam-taking corroborates. */
  params: string[];
  exported: boolean;
  callers: Pick<FunctionCaller, "call" | "arguments" | "kind">[];
  moduleSource: string;
  functionSource: string;
};

/** Injectable seams a composition root threads through: argv, working
 * directory, standard streams, environment. Matched on word boundaries so
 * `environment` or `standard` do not count. */
const INJECTABLE_SEAM = /\b(args|argv|cwd|stdout|stderr|stdin|env)\b/;

/** main()/runCli-shaped runtime entries. Bare `run` is deliberately absent:
 * mid-tree runners (runMigration, runBatch) are not composition roots. */
const ENTRY_NAME = /^(main|runCli|runCLI|cli|cliMain|runCommand|startCli)$/;

/** Raw process inputs a runtime caller passes: argv, env, stdio, cwd. */
const RAW_PROCESS_INPUT =
  /process\.(argv|env|stdin|stdout|stderr|cwd)|stdin|\b(argv|args|cwd|stdout|stderr|env)\b/;

const MODULE_PROCESS_INPUT = /process\.(argv|env|stdin)/;

export function isCompositionRootEntry(signal: CompositionRootSignal): boolean {
  // Seam-taking corroboration (required): the entry already accepts
  // injectable seams, marking it as a wiring boundary.
  const takesSeam = signal.params.some((param) => INJECTABLE_SEAM.test(param));
  if (!takesSeam) return false;

  // Caller IOC (required): binary entry, or every in-repo caller passes raw
  // process inputs. A value-held reference passes nothing, so it disqualifies.
  const callersRaw = signal.callers.every(
    (caller) =>
      (caller.kind ?? "call") === "call"
      && RAW_PROCESS_INPUT.test(`${caller.call} ${caller.arguments.join(" ")}`),
  );
  if (!callersRaw) return false;

  // Entry signal (at least one of the enumerated shapes).
  if (signal.name !== null && ENTRY_NAME.test(signal.name)) return true;
  if (
    MODULE_PROCESS_INPUT.test(signal.moduleSource)
    && (MODULE_PROCESS_INPUT.test(signal.functionSource)
      || signal.callers.some((caller) =>
        /process\.argv/.test(`${caller.call} ${caller.arguments.join(" ")}`)
      ))
  ) {
    return true;
  }
  if (signal.callers.length === 0 && signal.exported) return true;
  return false;
}
