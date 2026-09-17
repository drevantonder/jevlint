import { fetchUser } from "./fetch-user.js";

export async function handleRequest(userId: string) {
  return fetchUser(userId);
}
