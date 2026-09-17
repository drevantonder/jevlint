import { createApp } from "./app.js";

export function startServer(port: number): void {
  const app = createApp();
  app.listen(port);
}
