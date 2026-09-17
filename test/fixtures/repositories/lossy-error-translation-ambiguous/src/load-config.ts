import { parseConfig } from "./parser.js";

export class ConfigurationError extends Error {}

export function loadConfig(source: string) {
  try {
    return parseConfig(source);
  } catch {
    throw new ConfigurationError("Configuration is invalid");
  }
}
