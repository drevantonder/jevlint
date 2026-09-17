import { metrics } from "./metrics.js";

export interface User {
  id: string;
  name: string;
}

declare const users: Map<string, User>;

export function getUser(userId: string): User | undefined {
  metrics.increment("user_lookup");
  return users.get(userId);
}
