export type InvoiceItem = {
  price: number;
  quantity: number;
};

export function invoiceTotal(items: InvoiceItem[], taxRate: number): number {
  let total = 0;
  for (const item of items) {
    total += item.price * item.quantity;
  }
  total += total * taxRate;
  return Math.round(total * 100) / 100;
}

export function overdueReminder(accountEmail: string, daysOverdue: number): string {
  if (daysOverdue <= 0) return "";
  const urgency = daysOverdue > 30 ? "urgent" : "reminder";
  return `Send ${urgency} notice to ${accountEmail} for ${daysOverdue} days overdue.`;
}
