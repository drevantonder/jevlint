import { ReadOnlyUser } from "./ro-user.js";
import { User } from "./user.js";

export function auditUser(user: User): string {
  return user.constructor.name;
}

export function guest(): ReadOnlyUser {
  return new ReadOnlyUser();
}
