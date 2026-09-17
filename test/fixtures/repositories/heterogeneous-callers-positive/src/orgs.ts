import { lookupAccount } from "./lookup.js";

export function orgAccount(org: { id: string }) {
  return lookupAccount(org.id);
}
