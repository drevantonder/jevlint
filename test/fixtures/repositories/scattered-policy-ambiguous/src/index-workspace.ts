interface Workspace {
  id: string;
  plan: string;
  status: string;
}

export async function indexWorkspace(workspace: Workspace): Promise<void> {
  if (workspace.plan === "team" && workspace.status === "active") {
    await search.index(workspace.id);
  }
}
