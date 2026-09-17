import { users } from "./users.js";

export function memberDisplayName(id: string): string {
  const member = users.find((user) => user.id === id);
  if (!member) throw new NotFoundError(id);
  return member.profile.name;
}

class NotFoundError extends Error {
  constructor(id: string) {
    super(id);
  }
}
