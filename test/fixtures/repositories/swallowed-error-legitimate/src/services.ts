export declare const accounts: {
  delete(accountId: string): Promise<void>;
};

export declare const analytics: {
  track(event: string, properties: object): Promise<void>;
};

export declare const logger: {
  warn(message: string, context: object): void;
};
