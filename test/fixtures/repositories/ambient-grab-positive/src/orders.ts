import { Db } from "./db.js";

export function placeOrder(id: string) {
  const db = Db.getInstance();
  db.rows.push({ id });
  return db.rows.length;
}
