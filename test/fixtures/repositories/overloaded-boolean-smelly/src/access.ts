import { loadCachedPage, type User } from "./store.js";

export function checkEntry(cacheKey: string, user: User): boolean {
  const page = loadCachedPage(cacheKey);
  if (page !== null) return page !== null;
  if (!user.isActive) return false;
  return user.canDelete;
}
