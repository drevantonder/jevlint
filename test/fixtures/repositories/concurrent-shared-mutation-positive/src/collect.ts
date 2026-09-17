import { fetchOne } from "./client.js";

const results: number[] = [];

export async function collect(urls: string[]): Promise<number[]> {
  await Promise.all([
    (async () => {
      results.push(await fetchOne(urls[0] as string));
    })(),
    (async () => {
      results.push(await fetchOne(urls[1] as string));
    })(),
  ]);
  return results;
}
