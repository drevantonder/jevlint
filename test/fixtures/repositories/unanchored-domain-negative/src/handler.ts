import { acceptsOrigin } from "./origin-check.js";

export function handleMessage(origin: string) {
  if (!acceptsOrigin(origin)) throw new Error("forbidden origin");
  return { origin };
}
