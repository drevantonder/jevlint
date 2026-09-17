import { logger, searchHints } from "./search-hints.js";

export async function refreshSearchHints(productIds: string[]) {
  for (const productId of productIds) {
    try {
      await searchHints.refresh(productId);
    } catch (error) {
      logger.warn("Could not refresh search hints", { productId, error });
    }
  }
}
