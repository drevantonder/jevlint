import type { ProviderMessage } from "./provider-message.js";

export function handleProviderMessage(message: ProviderMessage): void {
  switch (message.kind) {
    case "payment":
      if (message.paymentId) recordPayment(message.paymentId);
      return;
    case "refund":
      if (message.refundId) recordRefund(message.refundId);
      return;
    case "dispute":
      if (message.disputeId) recordDispute(message.disputeId);
  }
}

declare function recordPayment(id: string): void;
declare function recordRefund(id: string): void;
declare function recordDispute(id: string): void;
