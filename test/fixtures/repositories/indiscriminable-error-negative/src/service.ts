import { loadConfig } from "./config.js";

export function startService(path: string): string {
  try {
    const config = loadConfig(path);
    return `serving on ${config.port}`;
  } catch (err) {
    console.log("service failed to start", err);
    throw err;
  }
}
