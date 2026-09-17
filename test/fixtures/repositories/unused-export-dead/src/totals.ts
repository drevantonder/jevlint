export function orphanTotal(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0);
}

export function liveTotal(items: number[]): number {
  return items.reduce((sum, item) => sum + item, 0);
}
