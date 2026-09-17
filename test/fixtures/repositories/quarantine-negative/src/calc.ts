export function total(rows: number[]): number {
  return rows.reduce((sum, row) => sum + row, 0);
}
