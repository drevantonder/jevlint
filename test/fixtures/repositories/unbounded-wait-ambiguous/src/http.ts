export async function requestJson(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  return response.json();
}
