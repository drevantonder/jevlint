import { accounts, analytics, logger } from "./services.js";

export async function deleteAccount(accountId: string) {
  await accounts.delete(accountId);

  // Analytics is explicitly best effort and does not affect account deletion.
  try {
    await analytics.track("account.deleted", { accountId });
  } catch (error) {
    logger.warn("Account deletion analytics failed", { error, accountId });
  }

  return { accountId, status: "deleted" as const };
}
