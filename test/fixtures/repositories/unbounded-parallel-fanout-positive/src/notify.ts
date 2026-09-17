import { sendEmail } from "./mailer.js";

export async function notifyAll(users: string[]): Promise<void> {
  await Promise.all(users.map((user) => sendEmail(user)));
}
