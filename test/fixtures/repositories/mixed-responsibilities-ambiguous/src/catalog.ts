export async function refreshCatalog(workspaceId: string): Promise<void> {
  await catalog.refresh(workspaceId);
}
