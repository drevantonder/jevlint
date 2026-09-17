export function createApp(): {
  get: (path: string, handler: () => unknown) => void;
  listen: (port: number) => void;
} {
  return {
    get: (path: string, handler: () => unknown) => {
      void path;
      void handler;
    },
    listen: (port: number) => {
      void port;
    },
  };
}
