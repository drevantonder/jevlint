export function parse(row: string): string[] {
  return row.split(",");
}

export function store(rows: string[][]): number {
  return rows.length;
}

export function format(rows: string[][]): string {
  return rows.map((row) => row.join(",")).join("\n");
}
