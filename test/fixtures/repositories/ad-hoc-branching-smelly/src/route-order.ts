export function routeOrder(order: Order): string {
  if (order.region === "EU" && order.legacyAccount) return "legacy-eu";
  if (order.customerFlags.includes("manual-review")) return "manual";
  if (order.source === "partner" && order.total > 1_000) return "partner-priority";
  return "standard";
}
