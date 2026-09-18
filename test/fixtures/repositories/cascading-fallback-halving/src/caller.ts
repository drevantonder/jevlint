import { embedBatch } from "./embed-batch.js";

export function loadDocuments(documents: string[]): Promise<number[][]> {
  return embedBatch(documents);
}
