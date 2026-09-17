export async function registerCustomer(input: { email: string }): Promise<{ id: string }> {
  return customers.insert(input);
}
