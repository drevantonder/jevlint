export type Batch = { ids: string[] };

let currentBatch: string[] = [];

export function appendToBatch(id: string) {
  currentBatch.push(id);
}

export function drainBatch(): string[] {
  const batch = currentBatch;
  currentBatch = [];
  return batch;
}
