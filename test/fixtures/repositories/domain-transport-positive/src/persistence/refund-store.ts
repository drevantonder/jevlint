export const refundStore = {
  find: async (refundId: string) => database.refunds.find(refundId),
  save: async (refund: Refund) => database.refunds.save(refund),
};
