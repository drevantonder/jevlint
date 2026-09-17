import { touchInvitation } from "invitation-registry";

export interface Invitation {
  id: string;
  expiresAt: Date;
  acceptedAt?: Date;
}

export function checkInvitation(invitation: Invitation, now: Date): boolean {
  touchInvitation(invitation.id);
  return !invitation.acceptedAt && invitation.expiresAt > now;
}
