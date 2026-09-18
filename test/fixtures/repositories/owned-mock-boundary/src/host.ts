import { hostname } from "node:os";

export function label(): string {
  return `host:${hostname()}`;
}
