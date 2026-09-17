export interface OrderEvent {
  orderId: string;
  total: number;
  currency: string;
  couponCode?: string;
}
