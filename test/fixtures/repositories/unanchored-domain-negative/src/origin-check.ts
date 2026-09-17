import { allowedHost } from "./config.js";

export function acceptsOrigin(origin: string): boolean {
  const host = new URL(origin).hostname;
  if (host === allowedHost || host.endsWith("." + allowedHost)) return true;
  return false;
}
