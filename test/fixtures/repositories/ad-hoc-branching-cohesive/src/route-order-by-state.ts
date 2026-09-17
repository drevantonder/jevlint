export function routeOrder(order: Order): string {
  switch (order.route) {
    case "manual":
      return "manual";
    case "partner":
      return "partner-priority";
    case "standard":
      return "standard";
  }
}
