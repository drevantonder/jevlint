import type { PaymentGateway } from "../src/payment-gateway.js";

export class FakePaymentGateway implements PaymentGateway {
  async charge(payment: Payment): Promise<Receipt> {
    return { id: "test", payment };
  }
}
