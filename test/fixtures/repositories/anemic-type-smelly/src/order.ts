export class Order {
  id = "";
  items: string[] = [];
  subtotal = 0;
  discountRate = 0;
  couponCode?: string;
  placedAt = "";

  get total(): number {
    return this.subtotal;
  }

  set total(value: number) {
    this.subtotal = value;
  }
}
