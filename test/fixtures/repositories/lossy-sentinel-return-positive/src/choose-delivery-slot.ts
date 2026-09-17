export interface Order {
  address?: { country: string };
  requestedDate: Date;
}

export interface DeliverySlot {
  id: string;
  country: string;
  date: Date;
}

declare const serviceAreas: Set<string>;
declare const deliverySlots: DeliverySlot[];

export function chooseDeliverySlot(order: Order): DeliverySlot | null {
  if (!order.address) return null;
  if (!serviceAreas.has(order.address.country)) return null;
  const slot = deliverySlots.find((candidate) =>
    candidate.country === order.address?.country && candidate.date >= order.requestedDate
  );
  if (!slot) return null;
  return slot;
}
