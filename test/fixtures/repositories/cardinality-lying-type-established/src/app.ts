import type { Settings } from "./settings.js";

export function theme(settings: Settings): string {
  return settings.theme;
}
