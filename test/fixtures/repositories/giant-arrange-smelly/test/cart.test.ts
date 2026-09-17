import { describe, expect, it } from "vitest";
import { checkout } from "../src/cart.js";

describe("cart", () => {
  it("checks out a cart with a loyalty member and a coupon", () => {
    const member = {
      id: "m-1",
      tier: "gold",
      points: 1200,
      address: { street: "1 Main St", city: "Springfield", zip: "12345" },
      preferences: { email: true, sms: false, paperless: true },
    };
    const coupon = { code: "SAVE10", percent: 10, expires: "2027-01-01", stackable: false };
    const cart = {
      items: [
        { sku: "a-1", qty: 2, price: 1999 },
        { sku: "b-2", qty: 1, price: 499 },
      ],
      currency: "USD",
      member,
      coupon,
      shipping: { method: "express", cost: 899, eta: "2 days" },
    };
    const receipt = checkout(cart);
    expect(receipt.total).toBe(4247);
  });
});
