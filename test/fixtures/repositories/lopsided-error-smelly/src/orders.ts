import { db } from "./db.js";

export async function fulfillOrder(orderId: string): Promise<string> {
  let order;
  try {
    order = await db.fetchOrder(orderId);
  } catch (error) {
    throw new Error(`cannot load order ${orderId}`, { cause: error });
  }
  let receipt;
  try {
    receipt = await db.charge(orderId);
  } catch (error) {
    throw new Error(`cannot charge order ${orderId}`, { cause: error });
  }
  const tracking = await db.ship(orderId);
  return `${order.id}:${receipt.id}:${tracking.id}`;
}
