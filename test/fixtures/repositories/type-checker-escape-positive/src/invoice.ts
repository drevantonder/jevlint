export type Invoice = { id: string; total: number };

export async function loadInvoice(id: string): Promise<number> {
  const response = await fetch(`https://api.example.com/invoices/${id}`);
  const invoice = (await response.json()) as Invoice;
  return invoice.total;
}
