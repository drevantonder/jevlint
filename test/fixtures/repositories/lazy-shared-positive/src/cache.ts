import { loadSettings, type Settings } from "./settings.js";

let cached: Settings | null = null;

export function getSettings(): Settings {
  if (!cached) cached = loadSettings();
  return cached;
}

export function currentTheme(): string {
  return getSettings().theme;
}

export function hasCache(): boolean {
  return cached !== null;
}
