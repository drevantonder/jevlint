import type { PaymentGateway } from "./payment-gateway.js";

export class InvoiceService {
  constructor(private readonly gateway: PaymentGateway) {}

  settle(payment: Payment): Promise<Receipt> {
    return this.gateway.charge(payment);
  }
}
