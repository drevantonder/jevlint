import type { ExportFormat } from "./export-format.js";

export function render(format: ExportFormat): string {
  if (format.formatJson && format.formatYaml) throw new Error("pick one format");
  if (format.formatJson) return "{}";
  if (format.formatYaml) return "---";
  return "table";
}

export const asJson: ExportFormat = { formatJson: true, formatYaml: false, formatTable: false };
export const asYaml: ExportFormat = { formatJson: false, formatYaml: true, formatTable: false };
