export type Cart = {
  items: { sku: string; qty: number; price: number }[];
  currency: string;
  member: unknown;
  coupon: { code: string; percent: number; expires: string; stackable: boolean };
  shipping: unknown;
};

export function checkout(cart: Cart): { total: number } {
  const subtotal = cart.items.reduce((sum, item) => sum + item.qty * item.price, 0);
  return { total: subtotal - cart.coupon.percent * 25 };
}
