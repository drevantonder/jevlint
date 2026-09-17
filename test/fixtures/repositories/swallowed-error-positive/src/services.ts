export declare const invoices: {
  load(invoiceId: string): Promise<{ id: string; total: number }>;
  markPublished(invoiceId: string): Promise<void>;
};

export declare const invoiceEvents: {
  publish(event: { type: string; invoice: { id: string; total: number } }): Promise<void>;
};

export declare const logger: {
  error(message: string, context: object): void;
};
