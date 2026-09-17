import { formatCents } from "./format.js";

export function cartLabel(totalCents: number): string {
  return `Total: ${formatCents(totalCents)}`;
}

export function refundLabel(refundCents: number): string {
  return `Refund: ${formatCents(refundCents)}`;
}
