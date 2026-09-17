import * as storage from "./storage";

export function trackStorage(ms: number): void {
  storage.recordStorageDuration(ms);
}
