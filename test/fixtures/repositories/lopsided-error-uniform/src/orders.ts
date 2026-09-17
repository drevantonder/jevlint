import { db } from "./db.js";

export async function fulfillOrder(orderId: string): Promise<string> {
  try {
    const order = await db.fetchOrder(orderId);
    const receipt = await db.charge(orderId);
    const tracking = await db.ship(orderId);
    return `${order.id}:${receipt.id}:${tracking.id}`;
  } catch (error) {
    throw new Error(`cannot fulfill order ${orderId}`, { cause: error });
  }
}
