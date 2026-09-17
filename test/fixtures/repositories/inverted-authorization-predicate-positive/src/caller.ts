import { canManageBilling } from "./team.js";

export function handleBillingRoute(isAdmin: boolean, isOwner: boolean): boolean {
  return canManageBilling({ isTeamAdmin: isAdmin, isTeamOwner: isOwner });
}
