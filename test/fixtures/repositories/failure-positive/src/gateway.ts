export const gateway = {
  async charge(amount: number): Promise<string> {
    if (amount <= 0) throw new Error("declined");
    return `receipt:${amount}`;
  },
};
