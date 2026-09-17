import { hydrateUser } from "./map-user.js";

export function loadUser(row: Record<string, unknown>): User {
  return hydrateUser(row);
}
