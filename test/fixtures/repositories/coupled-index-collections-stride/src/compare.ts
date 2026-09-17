export function compare(left: number[], right: number[]): number[] {
  const deltas: number[] = [];
  for (let i = 0; i < left.length; i += 1) {
    deltas.push((left[i] ?? 0) - (right[i * 2] ?? 0));
  }
  return deltas;
}
