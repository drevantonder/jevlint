import { chargeCustomer } from "../gateways/stripe-payment-gateway.js";

export async function checkout(order: Order, customer: Customer) {
  return chargeCustomer({
    customer,
    amountCents: order.totalCents,
    currency: order.currency,
  });
}
