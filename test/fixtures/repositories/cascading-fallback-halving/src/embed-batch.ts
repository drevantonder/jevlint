import { client, isTokenLimit } from "./client.js";

export async function embedBatch(items: string[]): Promise<number[][]> {
  if (items.length <= 1) {
    return client.embed(items);
  }
  try {
    return await client.embed(items);
  } catch (error) {
    if (!isTokenLimit(error)) throw error;
    const mid = Math.floor(items.length / 2);
    const first = await client.embed(items.slice(0, mid));
    const second = await client.embed(items.slice(mid));
    return [...first, ...second];
  }
}
