import { loadConfig } from "./config.js";

export function startService(path: string): string {
  try {
    const config = loadConfig(path);
    return `serving on ${config.port}`;
  } catch (err) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing config file";
    }
    throw err;
  }
}
