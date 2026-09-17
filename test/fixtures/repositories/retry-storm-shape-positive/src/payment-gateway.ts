export declare const paymentGateway: {
  charge(input: { orderId: string; paymentToken: string }): Promise<{ transactionId: string }>;
};

export declare function sleep(milliseconds: number): Promise<void>;
