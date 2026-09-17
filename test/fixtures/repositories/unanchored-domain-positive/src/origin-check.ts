import { allowedOrigin } from "./config.js";

export function acceptsOrigin(origin: string): boolean {
  if (origin.indexOf(allowedOrigin) !== -1) return true;
  return false;
}
