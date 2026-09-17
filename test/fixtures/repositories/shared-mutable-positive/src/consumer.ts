import { appendToBatch, drainBatch } from "./batch.js";

export function handleTick(id: string) {
  appendToBatch(id);
  return drainBatch();
}
