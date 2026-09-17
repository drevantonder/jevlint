import { updateProfile } from "./update-profile.js";

declare const form: { customerId: string; displayName: string };

export async function submitProfile(): Promise<void> {
  await updateProfile(form);
}
