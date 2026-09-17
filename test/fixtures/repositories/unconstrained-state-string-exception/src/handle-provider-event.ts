import type { ProviderEvent } from "./provider-event.js";

export function handleProviderEvent(event: ProviderEvent): void {
  switch (event.eventType) {
    case "invoice.paid":
      recordPayment(event.payload);
      return;
    case "invoice.failed":
      recordFailure(event.payload);
      return;
    default:
      recordUnknownProviderEvent(event);
  }
}

declare function recordPayment(payload: Record<string, unknown>): void;
declare function recordFailure(payload: Record<string, unknown>): void;
declare function recordUnknownProviderEvent(event: ProviderEvent): void;
