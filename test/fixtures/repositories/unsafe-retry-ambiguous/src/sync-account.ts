import { withRetry } from "@platform/retry";
import { accountSync } from "./account-sync.js";

export async function syncAccount(accountId: string) {
  return withRetry(() => accountSync.run(accountId), "background-sync");
}
