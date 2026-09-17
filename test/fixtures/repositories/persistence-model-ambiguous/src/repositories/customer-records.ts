export const customerRecords = {
  find: async (customerId: string) => customerSource.find(customerId),
};
