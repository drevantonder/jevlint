import { Db, getDatabase } from "./db.js";
import { PostgresStore } from "./store.js";
import type { Order } from "./store.js";

export function processOrder(order: Order): void {
  const store = new PostgresStore("postgres://localhost:5432/shop");
  const db = Db.getInstance();
  const legacy = getDatabase();
  store.save({ order, db, legacy });
}

export function listOrders(store: PostgresStore): Order[] {
  return store.all();
}
