import { deleteAccount } from "./delete-account.js";

export async function closeAccount(accountId: string) {
  const result = await deleteAccount(accountId);
  return result.status;
}
