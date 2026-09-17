import { sendReceipt } from "./mailer.js";

export function handleSignup(email: string) {
  sendReceipt(email);
}
