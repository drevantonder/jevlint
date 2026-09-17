import { readConfig } from "./config";

export async function loadFirst(path: string): Promise<string> {
  const config = await readConfig(path);
  if (!config) throw new Error("missing config");
  return config.name;
}

export async function loadSecond(path: string): Promise<string> {
  const config = await readConfig(path);
  if (!config) throw new Error("missing config");
  return config.label;
}

export function loadThird(path: string): Promise<string> {
  return readConfig(path).then((config) => {
    if (!config) return null;
    return config.name;
  });
}
