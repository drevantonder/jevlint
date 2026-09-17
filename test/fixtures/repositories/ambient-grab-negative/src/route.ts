import type { Db } from "./db.js";
import { placeOrder } from "./orders.js";

const db: Db = { rows: [] };

export function handleCheckout(id: string) {
  return placeOrder(db, id);
}
