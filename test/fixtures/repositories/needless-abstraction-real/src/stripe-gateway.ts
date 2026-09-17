import type { PaymentGateway } from "./payment-gateway.js";
import { stripe } from "@stripe/sdk";

export class StripeGateway implements PaymentGateway {
  async charge(payment: Payment): Promise<Receipt> {
    return stripe.charges.create(payment);
  }
}
