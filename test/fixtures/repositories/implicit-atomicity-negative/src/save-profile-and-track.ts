export async function saveProfileAndTrack(profile: Profile): Promise<void> {
  await profiles.save(profile);
  analytics.track("profile-saved", { profileId: profile.id });
}
