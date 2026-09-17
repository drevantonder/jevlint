export type Settings = { theme: string };

export function loadSettings(): Settings {
  return { theme: "light" };
}
