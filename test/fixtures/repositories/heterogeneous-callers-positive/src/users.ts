import { lookupAccount } from "./lookup.js";

export function userAccount(user: { id: string }) {
  return lookupAccount(user.id);
}
