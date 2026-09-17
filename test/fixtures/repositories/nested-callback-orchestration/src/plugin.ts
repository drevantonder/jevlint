type PluginApi = {
  registerTool(name: string, execute: () => Promise<string>): void;
};

export function createPlugin(): (api: PluginApi) => void {
  return (api) => {
    api.registerTool("create", async () => {
      const created = await createResource();
      return created.id;
    });
    api.registerTool("apply", async () => {
      const applied = await applyResource();
      return applied.id;
    });
  };
}
