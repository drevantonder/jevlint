import { startServer, stopServer } from "./server-lifecycle.js";

export async function runServer(config: ServerConfig, signal: AbortSignal): Promise<void> {
  await startServer(config);
  await waitForAbort(signal);
  await stopServer();
}
