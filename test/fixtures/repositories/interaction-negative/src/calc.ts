export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function total(rows: number[]): number {
  return round(rows.reduce((sum, row) => sum + row, 0));
}
