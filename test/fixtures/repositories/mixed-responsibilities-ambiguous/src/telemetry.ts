export async function recordWorkspaceRefresh(workspaceId: string): Promise<void> {
  await telemetry.record("workspace-refreshed", { workspaceId });
}
