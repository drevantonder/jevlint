type PlatformFetch = (path: string) => Promise<unknown>;

export function platformClient(fetch: PlatformFetch) {
  return {
    create: async () => {
      const response = await fetch("/create");
      return parseCreate(response);
    },
    list: async () => {
      const response = await fetch("/list");
      return parseList(response);
    },
  };
}
