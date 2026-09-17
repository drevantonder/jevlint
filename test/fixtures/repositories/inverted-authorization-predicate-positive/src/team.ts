export type TeamMembership = {
  isTeamAdmin: boolean;
  isTeamOwner: boolean;
};

export function canManageBilling(membership: TeamMembership): boolean {
  if (membership.isTeamAdmin && membership.isTeamOwner) return true;
  return false;
}

export function canViewBilling(membership: TeamMembership): boolean {
  if (membership.isTeamAdmin || membership.isTeamOwner) return true;
  return false;
}
