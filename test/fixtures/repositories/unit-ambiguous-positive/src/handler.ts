import { scheduleRetry } from "./retry.js";

export function onFailure() {
  scheduleRetry(5000);
}
