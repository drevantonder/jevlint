import { replica } from "./replica.js";

export async function readDocument(documentId: string) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await replica.read(documentId);
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }

  throw new Error("Unreachable retry state");
}
