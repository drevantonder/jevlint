import { normalizeProfile } from "./normalize-profile.js";
import type { Profile } from "./normalize-profile.js";

declare function renderPreview(profile: Profile): void;
declare function persistProfile(profile: Profile): Promise<void>;

export async function updateProfile(profile: Profile): Promise<void> {
  renderPreview(profile);
  const normalized = normalizeProfile(profile);
  await persistProfile(normalized);
}
