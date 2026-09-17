// Not sure why this works, but removing it breaks prod. Do not touch.
export function settle(order: { state: string; attempts: number }): string {
  if (order.state === "pending" && order.attempts > 3) return "escalated";
  if (order.state === "pending") return "retry";
  return order.state;
}
