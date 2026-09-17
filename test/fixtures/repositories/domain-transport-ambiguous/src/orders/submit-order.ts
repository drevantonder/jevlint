import type { Request } from "express";
import { orderService } from "./order-service.js";

export async function submitOrder(request: Request) {
  return orderService.submit(request.body);
}
