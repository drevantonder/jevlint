import { credentialSchema } from "./schemas.js";
import { store } from "./store.js";

export async function persistCredential(payload: unknown): Promise<string | undefined> {
  const result = credentialSchema.safeParse(payload);
  await store.save(result);
  return result.data?.token;
}
