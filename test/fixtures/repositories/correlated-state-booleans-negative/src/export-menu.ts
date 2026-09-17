import type { ExportCapabilities } from "./export-capabilities.js";

export function availableExports(capabilities: ExportCapabilities): string[] {
  const formats: string[] = [];
  if (capabilities.supportsPdf) formats.push("PDF");
  if (capabilities.supportsCsv) formats.push("CSV");
  if (capabilities.supportsJson) formats.push("JSON");
  if (capabilities.supportsEncryption) formats.push("Encrypted archive");
  return formats;
}
