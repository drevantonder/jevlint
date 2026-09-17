function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(url: string, attempts = 3): Promise<string> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url);
      return await response.text();
    } catch (error) {
      lastError = error;
      const backoff = 100 * 2 ** attempt + Math.random() * 50;
      await sleep(backoff);
    }
  }
  throw lastError;
}
