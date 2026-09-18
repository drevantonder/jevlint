import { formatCents } from "./helper.js";

export function label(total: number): string {
  return `$${formatCents(total)}`;
}
