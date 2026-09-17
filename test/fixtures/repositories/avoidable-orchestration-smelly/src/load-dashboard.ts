export async function loadDashboard(userId: string) {
  const profile = await loadProfile(userId);
  const preferences = await loadPreferences(userId);
  const recommendations = await loadRecommendations(userId);
  return { profile, preferences, recommendations };
}
