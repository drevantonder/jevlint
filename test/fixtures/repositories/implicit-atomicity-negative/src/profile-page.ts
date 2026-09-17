import { saveProfileAndTrack } from "./save-profile-and-track.js";

export async function updateProfile(profile: Profile): Promise<void> {
  await saveProfileAndTrack(profile);
}
