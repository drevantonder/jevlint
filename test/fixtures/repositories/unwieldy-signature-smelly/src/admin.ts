import { renameUser, updateUser } from "./update-user.js";
import type { UserData } from "./update-user.js";

export function promoteAdmin(userId: string, adminId: string, data: UserData): boolean {
  return updateUser(userId, adminId, data, undefined, true, false, 0);
}

export function bulkRefresh(userId: string, adminId: string, data: UserData): boolean {
  return updateUser(adminId, userId, data, undefined, false, true, 3);
}

export function rename(userId: string, data: UserData): boolean {
  return renameUser(userId, data);
}
