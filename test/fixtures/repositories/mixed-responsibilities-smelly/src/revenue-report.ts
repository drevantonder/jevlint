export async function renderRevenueDigest(): Promise<string> {
  const revenue = await analytics.weeklyRevenue();
  return `<p>Weekly revenue: ${revenue}</p>`;
}
