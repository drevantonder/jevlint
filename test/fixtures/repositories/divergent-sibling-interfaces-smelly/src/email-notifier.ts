import { NotifierBase } from "./notifier-base.js";

export class EmailNotifier extends NotifierBase {
  sendEmail(to: string): boolean {
    return to.includes("@");
  }
}
