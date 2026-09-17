import { requestJson } from "./http.js";

export async function fetchUser(userId: string) {
  return requestJson(`https://api.example.com/users/${userId}`);
}
