export declare const paymentGateway: {
  charge(input: { orderId: string; paymentToken: string }): Promise<{ transactionId: string }>;
};

export declare function sleepWithBackoff(attempt: number): Promise<void>;
