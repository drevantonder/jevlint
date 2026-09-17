export interface Profile {
  email: string;
  tags: string[];
  normalizationCount: number;
}

export function normalizeProfile(profile: Profile): Profile {
  profile.email = profile.email.trim().toLowerCase();
  profile.tags.sort();
  profile.normalizationCount += 1;
  return profile;
}
