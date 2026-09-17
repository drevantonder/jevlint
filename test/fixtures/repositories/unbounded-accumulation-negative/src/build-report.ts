export function buildReport(rows: string[]): string[] {
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(row.trim());
  }
  return lines;
}
