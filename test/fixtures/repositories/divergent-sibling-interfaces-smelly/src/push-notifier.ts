import { NotifierBase } from "./notifier-base.js";

export class PushNotifier extends NotifierBase {
  push(to: string): boolean {
    return to.length > 0;
  }
}
