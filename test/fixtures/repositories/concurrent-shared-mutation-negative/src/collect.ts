import { fetchOne } from "./client.js";

export async function collectSequential(urls: string[]): Promise<number[]> {
  const results: number[] = [];
  for (const url of urls) {
    results.push(await fetchOne(url));
  }
  return results;
}
