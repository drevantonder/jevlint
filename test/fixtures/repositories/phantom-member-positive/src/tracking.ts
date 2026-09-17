import * as storage from "./storage";

export function trackEmbedding(input: string): void {
  storage.createEmbedding(input);
}
