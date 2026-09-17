export async function fetchRemoteTotal(): Promise<number> {
  try {
    const response = await fetch("https://example.com/total");
    return (await response.json()) as number;
  } catch {
    return -1;
  }
}
