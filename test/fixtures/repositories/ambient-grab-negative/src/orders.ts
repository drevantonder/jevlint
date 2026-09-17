import type { Db } from "./db.js";

export function placeOrder(db: Db, id: string) {
  db.rows.push({ id });
  return db.rows.length;
}
