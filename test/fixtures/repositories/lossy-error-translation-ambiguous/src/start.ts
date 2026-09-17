import { ConfigurationError, loadConfig } from "./load-config.js";

export function start(source: string) {
  try {
    return boot(loadConfig(source));
  } catch (error) {
    if (error instanceof ConfigurationError) return { started: false, message: error.message };
    throw error;
  }
}
