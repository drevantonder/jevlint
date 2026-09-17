export class PaymentDeclinedError extends Error {
  readonly declineCode: string;

  constructor(declineCode: string) {
    super(`Payment declined: ${declineCode}`);
    this.declineCode = declineCode;
  }
}

export class GatewayUnavailableError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("Payment gateway unavailable");
    this.retryAfterMs = retryAfterMs;
  }
}

export declare const paymentGateway: {
  charge(input: { orderId: string; paymentToken: string }): Promise<{ transactionId: string }>;
};
