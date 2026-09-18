import type { Users } from "./users.js";

export function greet(user: Users): string {
  return `hello ${user.name}`;
}
