import { logger, store } from "./services.js";

// Logs and absorbs: the failure never reaches the caller, so nothing is
// handled twice.
export async function loadCached(key: string): Promise<string | null> {
  try {
    return await store.read(key);
  } catch (error) {
    logger.warn("cache miss", { key, error });
    return null;
  }
}

// Propagates without recording: clean escalation, nothing doubled.
export async function loadRequired(key: string): Promise<string> {
  try {
    return await store.read(key);
  } catch (error) {
    throw new Error(`required value missing: ${key}`, { cause: error });
  }
}
