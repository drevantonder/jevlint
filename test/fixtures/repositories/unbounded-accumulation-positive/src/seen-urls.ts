const seenUrls = new Map<string, number>();

export function trackRequest(url: string): number {
  seenUrls.set(url, Date.now());
  return seenUrls.size;
}
