export interface OrderProcess {
  orderId: string;
  status: string;
  paidAt?: Date;
  shippedAt?: Date;
}

export const newOrder: OrderProcess = {
  orderId: "order-1",
  status: "pending",
};
