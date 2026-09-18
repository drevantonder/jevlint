import { formatUser } from "./users.js";
import type { User } from "./users.js";

const ada: User = { id: "u1", name: "Ada" };

export function renderRoster(members: User[]): string[] {
  return members.map((member) => String(formatUser(member)));
}

renderRoster([ada]);
