import { lookupAccount } from "./lookup.js";

export function firstAdmin(user: { id: string }) {
  return lookupAccount(user.id);
}
