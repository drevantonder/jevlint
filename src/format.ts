import type { Diagnostic } from "./types.js";

export function formatText(diagnostics: Diagnostic[]): string {
  return diagnostics
    .map(
      (diagnostic) =>
        `${diagnostic.filePath}:${diagnostic.line}:${diagnostic.column}  ` +
        `${diagnostic.severity}  ${diagnostic.message}  ` +
        `${diagnostic.ruleId} (${diagnostic.probability.toFixed(2)})`,
    )
    .join("\n");
}

export function formatJson(diagnostics: Diagnostic[]): string {
  return JSON.stringify(diagnostics, null, 2);
}
