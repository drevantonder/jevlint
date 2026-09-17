import { loadProfile } from "./load-profile.js";

export async function renderProfile(userId: string) {
  const profile = await loadProfile(userId);
  return profile?.displayName ?? "Profile unavailable";
}
