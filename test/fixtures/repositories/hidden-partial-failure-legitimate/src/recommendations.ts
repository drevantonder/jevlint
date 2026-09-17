export declare const recommendations: {
  /** Optional merchandising suggestions. Product data remains valid without them. */
  forProduct(productId: string): Promise<string[]>;
};
