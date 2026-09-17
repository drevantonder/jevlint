import { credentialSchema } from "./schemas.js";
import { store } from "./store.js";

export async function persistCredential(payload: unknown): Promise<string> {
  const result = credentialSchema.safeParse(payload);
  if (!result.success) throw new Error("invalid credential payload");
  await store.save(result.data);
  return result.data.token;
}
