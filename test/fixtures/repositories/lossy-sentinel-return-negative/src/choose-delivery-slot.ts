interface DeliverySlot {
  id: string;
}

type SlotResult =
  | { kind: "invalid-address" }
  | { kind: "unsupported-area" }
  | { kind: "unavailable" }
  | { kind: "available"; slot: DeliverySlot };

export function chooseDeliverySlot(order: Order): SlotResult {
  if (!order.address) return { kind: "invalid-address" };
  if (!serviceAreas.has(order.address.country)) return { kind: "unsupported-area" };
  const slot = deliverySlots.find((candidate) => candidate.country === order.address.country);
  return slot ? { kind: "available", slot } : { kind: "unavailable" };
}
