interface Workspace {
  id: string;
  plan: string;
  status: string;
}

export async function refreshWorkspace(workspace: Workspace): Promise<void> {
  if (workspace.plan === "team" && workspace.status === "active") {
    await catalog.refresh(workspace.id);
  }
}
