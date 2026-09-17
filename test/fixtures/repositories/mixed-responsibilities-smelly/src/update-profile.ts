import { saveCustomer } from "./customer-store.js";
import { renderRevenueDigest } from "./revenue-report.js";
import { sendFinanceDigest } from "./mailer.js";
import { deleteExpiredSessions } from "./session-store.js";

export interface ProfileInput {
  customerId: string;
  displayName: string;
}

export async function updateProfile(input: ProfileInput): Promise<void> {
  await saveCustomer(input);
  const digest = await renderRevenueDigest();
  await sendFinanceDigest(digest);
  await deleteExpiredSessions();
}
