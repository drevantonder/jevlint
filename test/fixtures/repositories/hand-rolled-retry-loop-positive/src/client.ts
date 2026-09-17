import pRetry from "p-retry";

export function loadConfig(url: string): Promise<string> {
  return pRetry(() => fetch(url).then((response) => response.text()), { retries: 3 });
}
