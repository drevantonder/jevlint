import { routeOrder } from "./route-order-by-state.js";

export function checkout(order: Order) {
  return { order, route: routeOrder(order) };
}
