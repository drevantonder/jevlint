import { selectFields } from "./select-fields.js";

export function publicUser(user: User) {
  return selectFields(user, ["id", "name"]);
}

export function auditUser(user: User) {
  return selectFields(user, ["id", "email", "lastLoginAt"]);
}
