import { chooseDeliverySlot } from "./choose-delivery-slot.js";
import type { Order } from "./choose-delivery-slot.js";

export function deliveryMessage(order: Order): string {
  const slot = chooseDeliverySlot(order);
  return slot ? `Delivery slot ${slot.id}` : "No delivery slots are available";
}
