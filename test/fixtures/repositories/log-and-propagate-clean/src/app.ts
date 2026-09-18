import { logger } from "./services.js";
import { loadRequired } from "./loader.js";

// Upstream handler that records the same failure the callee propagates.
export async function boot(key: string): Promise<string> {
  try {
    return await loadRequired(key);
  } catch (error) {
    logger.error("boot failed", { key, error });
    throw error;
  }
}
