import { serializeReport } from "./serialize-report.js";

export function reportCsv(report: Report): string {
  return serializeReport(report, { format: "csv", includeHeaders: true });
}
