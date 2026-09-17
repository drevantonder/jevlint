import { request } from "./request.js";

export function loadUser(id: string) {
  return request(`/users/${id}`, { method: "GET", timeoutMs: 500 });
}

export function createUser(user: User) {
  return request("/users", {
    method: "POST",
    headers: { "content-type": "application/json" },
  });
}
