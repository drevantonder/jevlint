import { currentConfig, type Monitor } from "./monitor.js";

export function readInterval(monitor: Monitor): number {
  return currentConfig(monitor, "compact").interval;
}
