export interface PaymentGateway {
  charge(payment: Payment): Promise<Receipt>;
}
