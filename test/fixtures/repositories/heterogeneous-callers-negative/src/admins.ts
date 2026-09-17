import { lookupAccount } from "./lookup.js";

export function secondAdmin(user: { id: string }) {
  return lookupAccount(user.id);
}
