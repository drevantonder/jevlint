import { refreshCatalog } from "./catalog.js";
import { invalidateWorkspaceCache } from "./cache.js";
import { recordWorkspaceRefresh } from "./telemetry.js";

export async function refreshWorkspace(workspaceId: string): Promise<void> {
  await refreshCatalog(workspaceId);
  await invalidateWorkspaceCache(workspaceId);
  await recordWorkspaceRefresh(workspaceId);
}
