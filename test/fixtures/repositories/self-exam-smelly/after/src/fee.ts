import { discountRate } from "./discount.js";

export function baseFee(cents: number): number {
  return cents;
}

export function calculateFee(cents: number): number {
  return Math.round(cents * (1 - discountRate()));
}
