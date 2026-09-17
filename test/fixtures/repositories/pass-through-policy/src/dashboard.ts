import { findActiveUsers } from "./active-users.js";

export async function dashboardUsers() {
  return findActiveUsers();
}
