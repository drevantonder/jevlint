import { NotifierBase } from "./notifier-base.js";

export class SmsNotifier extends NotifierBase {
  deliverSms(to: string): boolean {
    return to.length > 0;
  }
}
