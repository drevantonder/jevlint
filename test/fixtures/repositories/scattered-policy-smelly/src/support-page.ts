import { routeSupport } from "./route-support.js";
import type { Account } from "./route-support.js";

export function openSupportRequest(account: Account): void {
  supportQueue.open(routeSupport(account), account.id);
}
