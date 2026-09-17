// Generated from the provider's versioned webhook schema. Do not edit.
export interface ProviderMessage {
  kind: "payment" | "refund" | "dispute";
  paymentId?: string;
  refundId?: string;
  disputeId?: string;
}
