import { get, remove, save } from "./store";

export async function handle(key: string): Promise<string | undefined> {
  const value = await get(key);
  if (value === undefined) return undefined;
  await save(`${key}:seen`, "1");
  remove(key, () => {});
  return value;
}
