import type { OrderProcess } from "./order-process.js";

export function availableAction(order: OrderProcess): string {
  switch (order.status) {
    case "pending":
      return "collect-payment";
    case "paid":
      return "ship";
    case "shipped":
      return "track";
    case "cancelled":
      return "none";
    default:
      throw new Error(`Unknown order status: ${order.status}`);
  }
}

export function markPaid(order: OrderProcess): OrderProcess {
  return { ...order, status: "paid", paidAt: new Date() };
}
