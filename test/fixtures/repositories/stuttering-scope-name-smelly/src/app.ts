import { Config } from "./config.js";

export function loadNames(config: Config, names: string[]): string[] {
  return names.map((name) => config.configPath(name));
}
