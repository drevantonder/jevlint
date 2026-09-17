export type Member = { id: string; profile: { name: string } };

export function displayName(member: Member | null | undefined): string {
  if (member == null) return "guest";
  return member.profile.name;
}
