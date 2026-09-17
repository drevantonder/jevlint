// Retries transient failures with exponential backoff.
export async function fetchWithRetry(
  load: () => Promise<string>,
  attempts = 3,
): Promise<string> {
  let delay = 25;
  let lastError: unknown = new Error("fetchWithRetry exhausted attempts");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await load();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay *= 2;
      }
    }
  }
  throw lastError;
}
