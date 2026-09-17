import type { Request, Response } from "express";
import { placeOrder } from "../application/place-order.js";

export async function placeOrderRoute(request: Request, response: Response) {
  const result = await placeOrder({ customerId: request.user.id, lines: request.body.lines });
  switch (result.kind) {
    case "accepted":
      return response.status(202).json({ orderId: result.orderId });
    case "out-of-stock":
      return response.status(409).json({ code: "out-of-stock", sku: result.sku });
    case "invalid":
      return response.status(422).json({ errors: result.errors });
  }
}
