export async function fetchOrders(): Promise<unknown> {
  const response = await fetch("http://localhost:3000/api/orders");
  return response.json();
}
