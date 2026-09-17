import pLimit from "p-limit";
import { sendEmail } from "./mailer.js";

const limit = pLimit(5);

export async function notifyAll(users: string[]): Promise<void> {
  await Promise.all(users.map((user) => limit(() => sendEmail(user))));
}
