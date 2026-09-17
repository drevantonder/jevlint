import { NotifierBase } from "./notifier-base.js";

export class EmailNotifier extends NotifierBase {
  send(to: string, subject: string): boolean {
    return to.includes("@") && subject.length > 0;
  }
}
