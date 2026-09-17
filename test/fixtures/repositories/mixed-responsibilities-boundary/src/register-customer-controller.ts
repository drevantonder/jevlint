import { parseRegistrationRequest } from "./http.js";
import { registerCustomer } from "./register-customer.js";
import { created, invalidRequest } from "./responses.js";

export async function registerCustomerController(request: Request): Promise<Response> {
  const input = await parseRegistrationRequest(request);
  if (!input.ok) return invalidRequest(input.errors);
  const customer = await registerCustomer(input.value);
  return created({ customerId: customer.id });
}
