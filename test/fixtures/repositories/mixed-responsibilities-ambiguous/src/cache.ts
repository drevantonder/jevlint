export async function invalidateWorkspaceCache(workspaceId: string): Promise<void> {
  await cache.invalidate(workspaceId);
}
