import { sendNotification } from "./send-notification.js";

export function sendReset(link: string) {
  return sendNotification(`Reset at ${link}`, { channel: "email" });
}
