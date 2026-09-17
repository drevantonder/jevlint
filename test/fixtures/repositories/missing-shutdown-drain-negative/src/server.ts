import { createApp, destroySocket, markUnready } from "./app.js";

const openSockets = new Set<unknown>();

export function startServer(port: number): void {
  const app = createApp();
  const server = app.listen(port);
  process.on("SIGTERM", () => {
    markUnready();
    for (const socket of openSockets) destroySocket(socket);
    server.close(() => process.exit(0));
  });
}
