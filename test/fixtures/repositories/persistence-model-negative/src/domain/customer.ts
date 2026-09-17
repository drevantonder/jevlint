export class Customer {
  static restore(state: CustomerState): Customer {
    return new Customer(state.id, state.creditLimitCents, state.riskBand);
  }

  private constructor(
    readonly id: string,
    readonly creditLimitCents: number,
    readonly riskBand: "low" | "medium" | "high",
  ) {}
}
