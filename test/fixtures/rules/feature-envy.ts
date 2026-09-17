interface Customer {
  tier: "standard" | "gold";
  yearsActive: number;
  country: string;
  discountFor(total: number): number;
}

class EnviousInvoice {
  constructor(
    private readonly customer: Customer,
    private readonly total: number,
  ) {}

  discount(): number {
    if (this.customer.tier === "gold" && this.customer.yearsActive > 5) {
      return this.total * 0.2;
    }
    if (this.customer.country === "CA") return this.total * 0.05;
    return 0;
  }
}

class CohesiveInvoice {
  constructor(
    private readonly customer: Customer,
    private readonly total: number,
  ) {}

  discount(): number {
    return this.customer.discountFor(this.total);
  }
}
