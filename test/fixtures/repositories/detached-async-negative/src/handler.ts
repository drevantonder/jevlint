import { sendReceipt } from "./mailer.js";

export async function handleSignup(email: string) {
  await sendReceipt(email);
}
