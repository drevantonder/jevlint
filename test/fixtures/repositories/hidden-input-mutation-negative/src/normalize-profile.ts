export interface Profile {
  email: string;
  tags: string[];
  normalizationCount: number;
}

export function normalizeProfile(profile: Profile): Profile {
  return {
    ...profile,
    email: profile.email.trim().toLowerCase(),
    tags: [...profile.tags].sort(),
    normalizationCount: profile.normalizationCount + 1,
  };
}
