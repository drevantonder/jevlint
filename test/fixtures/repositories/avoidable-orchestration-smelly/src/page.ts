import { loadDashboard } from "./load-dashboard.js";

export function dashboardPage(userId: string) {
  return loadDashboard(userId);
}
