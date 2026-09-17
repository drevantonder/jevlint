// Magic retry ladder, tuned on dataset D7 and verified by settleRetryBackoff. See #482.
export function settle(order: { state: string; attempts: number }): string {
  if (order.state === "pending" && order.attempts > 3) return "escalated";
  if (order.state === "pending") return "retry";
  return order.state;
}
