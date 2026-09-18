export function planBatches(items: string[]): string[][] {
  const batches: string[][] = [];
  for (const item of items) batches.push([item]);
  return batches;
}

export function shipBatches(batches: string[][]): number {
  return batches.length;
}
