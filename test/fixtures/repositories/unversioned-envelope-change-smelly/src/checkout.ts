import type { OrderEvent } from "./order-event";

export function summarize(event: OrderEvent): string {
  return `${event.orderId}:${event.total}`;
}
