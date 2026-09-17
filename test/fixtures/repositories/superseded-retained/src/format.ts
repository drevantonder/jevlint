export function formatUserDisplay(name: string): string {
  return name.trim().toLowerCase().replaceAll(/\s+/g, "-");
}

export function cardTitle(name: string): string {
  return `Member: ${formatUserDisplay(name)}`;
}
