interface Order {
  region: string;
  legacyAccount: boolean;
  customerFlags: string[];
  source: string;
  total: number;
  route: "standard" | "manual" | "partner";
}

export function routeOrder(order: Order): string {
  if (order.region === "EU" && order.legacyAccount) return "legacy-eu";
  if (order.customerFlags.includes("manual-review")) return "manual";
  if (order.source === "partner" && order.total > 1_000) return "partner-priority";
  return "standard";
}

export function routeOrderByPolicy(order: Order): string {
  switch (order.route) {
    case "manual":
      return "manual";
    case "partner":
      return "partner-priority";
    case "standard":
      return "standard";
  }
}
