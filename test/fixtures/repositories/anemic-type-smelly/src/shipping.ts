import { Order } from "./order.js";

export function shippingMethod(order: Order): string {
  return order.couponCode ? "express" : "standard";
}
