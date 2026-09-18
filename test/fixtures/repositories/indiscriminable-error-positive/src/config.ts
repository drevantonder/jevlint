import { readFileSync } from "node:fs";

export type Config = {
  port: number;
};

export function loadConfig(path: string): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error("something went wrong");
  }
  try {
    return JSON.parse(raw) as Config;
  } catch (err) {
    throw new Error("something went wrong");
  }
}
