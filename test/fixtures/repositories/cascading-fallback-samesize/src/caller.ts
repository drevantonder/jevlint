import { fetchUser } from "./fetch-user.js";

export function loadUser(id: number): Promise<unknown> {
  return fetchUser(id);
}
