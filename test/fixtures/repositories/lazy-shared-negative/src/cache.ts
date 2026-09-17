import { loadSettings, type Settings } from "./settings.js";

const cached: Settings = loadSettings();

export function getSettings(): Settings {
  return cached;
}
