import type { WireInvoice } from "./wire.js";
import type { DomainInvoice } from "./domain.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isDomainInvoice(value: unknown): value is DomainInvoice {
  if (!isRecord(value)) return false;
  return typeof value.id === "string" && typeof value.totalCents === "number";
}

export function parseWireInvoice(input: WireInvoice): DomainInvoice {
  if (!isDomainInvoice(input)) throw new Error("invalid wire invoice");
  return input;
}
