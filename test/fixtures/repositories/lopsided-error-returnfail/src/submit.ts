import { db } from "./db.js";
import { fail } from "./respond.js";

export async function submit(orderId: string): Promise<unknown> {
  let order;
  try {
    order = await db.fetchOrder(orderId);
  } catch {
    return fail(400, { step: "load" });
  }
  let receipt;
  try {
    receipt = await db.charge(orderId);
  } catch {
    return fail(400, { step: "charge" });
  }
  if (!order.ready) {
    return fail(409, { step: "ready" });
  }
  const tracking = await db.ship(orderId);
  return tracking.id;
}
