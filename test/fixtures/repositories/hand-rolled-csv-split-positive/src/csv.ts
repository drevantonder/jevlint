export type CsvRow = Record<string, string>;

export function parseCsv(input: string): CsvRow[] {
  const lines = input.trim().split("\n");
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: CsvRow = {};
    for (let index = 0; index < headers.length; index += 1) {
      row[headers[index]] = cells[index] ?? "";
    }
    return row;
  });
}
