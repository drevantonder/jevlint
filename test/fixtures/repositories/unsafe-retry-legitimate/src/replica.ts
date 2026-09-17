export declare const replica: {
  /** Idempotent read from the local replica. */
  read(documentId: string): Promise<{ id: string; body: string } | null>;
};
