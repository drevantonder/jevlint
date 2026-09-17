export declare const mailer: {
  send(recipientId: string): Promise<{ recipientId: string; messageId: string }>;
};
