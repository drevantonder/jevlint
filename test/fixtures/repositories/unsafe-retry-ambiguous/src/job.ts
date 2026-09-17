import { syncAccount } from "./sync-account.js";

export async function runSyncJob(accountId: string) {
  return syncAccount(accountId);
}
