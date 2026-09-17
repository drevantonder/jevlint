export function isEligible(customer: { tier: string }): string | null {
  if (customer.tier === "gold") return "priority";
  return null;
}

export function isReady(items: string[]): boolean {
  return items.length > 0;
}

export function fetchStatus(code: number): string {
  if (code === 200) return "ok";
  return "unknown";
}

export function isUser(value: unknown): value is { id: string } {
  return typeof value === "object" && value !== null && "id" in value;
}
