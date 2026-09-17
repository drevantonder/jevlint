export const orderService = {
  submit: async (input: unknown) => orderQueue.send(input),
};
