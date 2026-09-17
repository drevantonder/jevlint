import { refreshSearchHints } from "./refresh-search-hints.js";

export async function finishProductImport(productIds: string[]) {
  await refreshSearchHints(productIds);
  return { imported: productIds.length };
}
