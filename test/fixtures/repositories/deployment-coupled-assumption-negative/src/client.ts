export async function fetchOrders(): Promise<unknown> {
  const baseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
  const response = await fetch(`${baseUrl}/api/orders`);
  return response.json();
}
