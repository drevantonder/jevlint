import { persistCredential } from "./handler.js";

export async function handleSignup(payload: unknown): Promise<void> {
  await persistCredential(payload);
}
