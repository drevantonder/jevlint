export const ledger = {
  post(cents: number): boolean {
    return cents >= 0;
  },
};
