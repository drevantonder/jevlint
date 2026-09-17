import { routeOrder } from "./route-order.js";

export function checkout(order: Order) {
  return { order, route: routeOrder(order) };
}
