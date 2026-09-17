import { users } from "./users.js";

export function memberDisplayName(id: string): string {
  const member = users.find((user) => user.id === id);
  return member.profile.name;
}
