import { reserveItems } from "./inventory.js";
import { capturePayment } from "./payments.js";
import { createShipment } from "./shipments.js";
import { markFulfilled } from "./orders.js";

export interface Order {
  id: string;
  items: Array<{ sku: string; quantity: number }>;
  paymentId: string;
  shippingAddress: string;
}

export async function fulfillOrder(order: Order): Promise<void> {
  await reserveItems(order.items);
  await capturePayment(order.paymentId);
  const shipment = await createShipment(order.items, order.shippingAddress);
  await markFulfilled(order.id, shipment.id);
}
