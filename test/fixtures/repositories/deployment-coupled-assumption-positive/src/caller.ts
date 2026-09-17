import { fetchOrders } from "./client.js";

export function loadOrders(): Promise<unknown> {
  return fetchOrders();
}
