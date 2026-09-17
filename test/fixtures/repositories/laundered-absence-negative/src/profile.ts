export interface Profile {
  nickname?: string;
}

export function displayName(profile: Profile): string {
  return profile.nickname ?? "anonymous";
}
