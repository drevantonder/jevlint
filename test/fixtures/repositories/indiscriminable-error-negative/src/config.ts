import { readFileSync } from "node:fs";

export type Config = {
  port: number;
};

export class ConfigNotFoundError extends Error {
  readonly configPath: string;

  constructor(configPath: string, options?: { cause?: unknown }) {
    super(`config file not found: ${configPath}`, options);
    this.name = "ConfigNotFoundError";
    this.configPath = configPath;
  }
}

export class ConfigParseError extends Error {
  readonly configPath: string;

  constructor(configPath: string, options?: { cause?: unknown }) {
    super(`config file is not valid JSON: ${configPath}`, options);
    this.name = "ConfigParseError";
    this.configPath = configPath;
  }
}

export function loadConfig(path: string): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigNotFoundError(path, { cause: err });
  }
  try {
    return JSON.parse(raw) as Config;
  } catch (err) {
    throw new ConfigParseError(path, { cause: err });
  }
}
