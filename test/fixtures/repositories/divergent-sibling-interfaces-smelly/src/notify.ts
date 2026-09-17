import { EmailNotifier } from "./email-notifier.js";
import { PushNotifier } from "./push-notifier.js";
import { SmsNotifier } from "./sms-notifier.js";

export function notify(channel: string, to: string): boolean {
  if (channel === "email") return new EmailNotifier().sendEmail(to);
  if (channel === "sms") return new SmsNotifier().deliverSms(to);
  return new PushNotifier().push(to);
}
