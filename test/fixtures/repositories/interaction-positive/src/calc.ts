export const math = {
  round(value: number): number {
    return Math.round(value * 100) / 100;
  },
};

export function total(rows: number[]): number {
  return math.round(rows.reduce((sum, row) => sum + row, 0));
}
