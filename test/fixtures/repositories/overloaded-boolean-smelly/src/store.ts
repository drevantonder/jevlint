export type User = {
  id: string;
  isActive: boolean;
  canDelete: boolean;
};

export function loadCachedPage(cacheKey: string): string | null {
  void cacheKey;
  return null;
}

export function isCacheWarm(cacheKey: string): boolean {
  void cacheKey;
  return false;
}
