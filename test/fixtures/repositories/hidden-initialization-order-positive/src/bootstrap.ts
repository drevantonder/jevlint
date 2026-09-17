import { configurePayments } from "./payments.js";

export function bootstrapPayments(): void {
  configurePayments(createPaymentClient());
}
