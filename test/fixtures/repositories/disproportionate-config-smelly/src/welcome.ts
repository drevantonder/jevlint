import { sendNotification } from "./send-notification.js";

export function sendWelcome(name: string) {
  return sendNotification(`Welcome ${name}`, { channel: "email" });
}
