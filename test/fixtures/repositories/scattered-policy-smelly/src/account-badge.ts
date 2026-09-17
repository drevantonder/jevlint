import type { Account } from "./route-support.js";

export function accountBadge(account: Account): string | null {
  if (account.plan === "enterprise" && account.status === "active") {
    return "Enterprise support";
  }
  return null;
}
