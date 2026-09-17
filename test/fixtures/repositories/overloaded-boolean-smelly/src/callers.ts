import { checkEntry } from "./access.js";
import { isCacheWarm, type User } from "./store.js";

export function renderPage(cacheKey: string, user: User): string {
  if (checkEntry(cacheKey, user)) return "page:served-from-cache";
  return "page:rendered-fresh";
}

export function purgeRecord(cacheKey: string, user: User): string {
  if (checkEntry(cacheKey, user)) return "record:purged-by-permission";
  throw new Error("record:permission-denied");
}

export function syncEntry(cacheKey: string, user: User): string {
  const entry = checkEntry(cacheKey, user);
  if (entry && !isCacheWarm(cacheKey)) return "entry:permission-granted";
  if (entry) return "entry:already-cached";
  return "entry:inactive-user";
}

export function refreshView(cacheKey: string, user: User): string {
  if (checkEntry(cacheKey, user)) return "view:from-cache";
  return "view:fetch-fresh";
}

export function grantAdmin(cacheKey: string, user: User): string {
  if (checkEntry(cacheKey, user)) return "admin:granted-by-permission";
  throw new Error("admin:denied");
}
