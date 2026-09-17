export interface SerializeOptions {
  format: "json" | "csv";
  includeHeaders?: boolean;
}

export function serializeReport(report: Report, options: SerializeOptions): string {
  if (options.format === "json") return JSON.stringify(report.rows);
  const rows = options.includeHeaders
    ? [report.columns, ...report.rows]
    : report.rows;
  return rows.map((row) => row.join(",")).join("\n");
}
