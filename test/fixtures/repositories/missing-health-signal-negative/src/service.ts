import { createApp } from "./app.js";
import { getUser } from "./users.js";

export function startService(port: number): void {
  const app = createApp();
  app.get("/users", getUser);
  app.get("/healthz", () => ({ ok: true }));
  app.listen(port);
}
