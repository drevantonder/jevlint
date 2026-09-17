export type Config = { endpoint: string };

const settings: Record<string, string> = {};
settings["endpoint"] = "https://api.example.com";

export function endpoint(): string {
  return settings["endpoint"] ?? "";
}
