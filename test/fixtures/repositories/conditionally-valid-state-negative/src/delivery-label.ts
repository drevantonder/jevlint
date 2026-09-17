import type { DeliveryUpdate } from "./delivery-update.js";

export function deliveryLabel(update: DeliveryUpdate): string {
  switch (update.phase) {
    case "ordered":
      return `Order received${update.note ? `: ${update.note}` : ""}`;
    case "packed":
      return `Packed${update.note ? `: ${update.note}` : ""}`;
    case "shipped":
      return `Shipped${update.note ? `: ${update.note}` : ""}`;
  }
}
