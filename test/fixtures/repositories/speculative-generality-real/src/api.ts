import { serializeReport } from "./serialize-report.js";

export function reportJson(report: Report): string {
  return serializeReport(report, { format: "json" });
}
